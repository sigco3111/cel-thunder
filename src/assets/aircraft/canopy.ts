/**
 * Canopy: a framed multi-pane greenhouse, not a glass blob.
 *
 * The glazing is a loft of half-superellipse sections along the cockpit
 * opening. The section exponent is above 2, which flattens the top — real
 * canopies are formed over a former and are noticeably flat across the crown,
 * and that flat is where the hard specular streak lands.
 *
 * Frames are swept tubes following the *same* section curve as the glass, so
 * they sit exactly on it: two sill rails, the windscreen arch, a centre post up
 * the windscreen, transverse bows over the hood, and the rear bow. They are hull
 * material, so they take the aircraft's paint, its panel lines and its
 * weathering, which is what stops the canopy reading as a separate object bolted
 * onto the model.
 */

import * as THREE from 'three';
import type { AircraftSpec } from '../../shared/aircraft';
import type { UvBox } from '../textures/atlas';
import { MeshBuilder, mergeGeoms, tubeGeom } from './geom';
import { bubbleCanopy } from './fuselage';
import type { FuselageProfile } from './fuselage';

export interface CanopyResult {
  glass: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
  /** Rear of the glazed hood, for placing the aerial mast. */
  rearZ: number;
  /** Cockpit opening centre, for placing the pilot and the seat. */
  centreZ: number;
  sillY: number;
}

const sgnpow = (v: number, e: number) => (v < 0 ? -Math.pow(-v, e) : Math.pow(v, e));

/** Longitudinal profile of the glasshouse, in fractions of width/height. */
interface Stn { t: number; z: number; w: number; h: number; n: number }

function stations(spec: AircraftSpec, prof: FuselageProfile): Stn[] {
  const c = spec.geom.canopy;
  // The spec's canopy box is generous. Trimming the width and, more
  // importantly, the height stops the hood reading as a bus shelter: a fighter
  // canopy clears the pilot's head and no more, and the windscreen is a long
  // shallow rake rather than a vertical arch.
  const bubble = bubbleCanopy(spec);
  const W = c.width * (bubble ? 0.86 : 0.80), H = c.height * (bubble ? 0.98 : 0.80);
  const zF = c.z0 + 0.46;                 // windscreen base, on the decking
  const zA = c.z0 + 0.05;                 // top of the windscreen arch
  const zR = c.z1;                        // rear bow of the sliding hood
  const zT = c.z1 - Math.max(0.5, (c.z0 - c.z1) * (bubble ? 0.28 : 0.50));
  const raw: [number, number, number, number][] = bubble ? [
    // Teardrop hood: one continuous blown shell, widest and tallest just behind
    // the pilot, closing to a short rounded tail on the cut-down decking.
    [zF, 0.30, 0.16, 3.0],
    [zF - (zF - zA) * 0.45, 0.62, 0.56, 2.7],
    [zF - (zF - zA) * 0.80, 0.86, 0.86, 2.4],
    [zA, 0.96, 0.98, 2.2],
    [zA - (zA - zR) * 0.34, 1.00, 1.00, 2.05],
    [zA - (zA - zR) * 0.70, 0.99, 0.98, 2.0],
    [zR, 0.90, 0.88, 2.05],
    [zR - (zR - zT) * 0.55, 0.62, 0.56, 2.2],
    [zT, 0.20, 0.14, 2.5],
  ] : [
    [zF, 0.28, 0.14, 3.2],
    [zF - (zF - zA) * 0.45, 0.60, 0.53, 2.9],
    [zF - (zF - zA) * 0.80, 0.84, 0.85, 2.7],
    [zA, 0.94, 0.97, 2.55],
    [zA - (zA - zR) * 0.32, 1.00, 1.00, 2.40],
    [zA - (zA - zR) * 0.70, 0.98, 0.95, 2.35],
    [zR, 0.84, 0.80, 2.45],
    [zR - (zR - zT) * 0.45, 0.55, 0.48, 2.6],
    [zT, 0.18, 0.10, 2.8],
  ];
  void prof;
  return raw.map((r, i) => ({ t: i / (raw.length - 1), z: r[0], w: r[1] * W, h: r[2] * H, n: r[3] }));
}

/**
 * The hole in the top of the fuselage that the canopy sits over.
 *
 * The cockpit is only a cockpit if you can see into it, and you cannot see into
 * a closed monocoque tube. The fuselage loft therefore cuts an opening whose
 * plan outline is exactly the base of the glasshouse — that is what a sill *is*
 * — so this has to come from the same station table the canopy is lofted from,
 * or the glass and the hole disagree by a few centimetres and daylight shows
 * through the join.
 *
 * The opening runs from the windscreen arch (where the instrument panel and its
 * coaming close it off) back to the rear bow, with its corners rounded over the
 * last ~15 cm at each end, which is how a stressed-skin cutout is actually
 * made: a square corner is a crack starter.
 */
export interface CanopyOpening {
  /** Forward end, body z. Larger than 'z1'. */
  z0: number;
  /** Aft end, body z. */
  z1: number;
  /** Lofted glasshouse height above the sill, metres — the head room. */
  height: number;
  /** Half-width of the opening at body z, metres. Zero outside [z1, z0]. */
  halfWidth(z: number): number;
  /** Sill height at body z — the same line the canopy is lofted from. */
  sillY(z: number): number;
}

export function canopyOpening(spec: AircraftSpec, prof: FuselageProfile): CanopyOpening {
  const st = stations(spec, prof);
  const ARCH = 3, REAR_BOW = 6;
  const z0 = st[ARCH].z, z1 = st[REAR_BOW].z;
  const span = Math.max(0.2, z0 - z1);
  // Corner radius as a fraction of the opening length: short enough to keep the
  // sill nearly straight down the sides, long enough that the ends read round.
  const corner = Math.min(0.22, 0.16 / span);

  const wAt = (z: number): number => {
    // Piecewise-linear across the arch → rear-bow stations.
    for (let i = ARCH; i < REAR_BOW; i++) {
      const a = st[i], b = st[i + 1];
      if (z <= a.z && z >= b.z) {
        const t = (a.z - z) / Math.max(1e-4, a.z - b.z);
        return a.w + (b.w - a.w) * t;
      }
    }
    return z > z0 ? st[ARCH].w : st[REAR_BOW].w;
  };

  return {
    z0,
    z1,
    height: spec.geom.canopy.height * (bubbleCanopy(spec) ? 0.98 : 0.80),
    sillY: (z) => prof.topY(z) - 0.015,
    halfWidth(z) {
      if (z >= z0 || z <= z1) return 0;
      const u = (z0 - z) / span;
      // Elliptical corner blend: 1 across the middle, → 0 at either end.
      const k = Math.min(1, Math.min(u, 1 - u) / corner);
      return wAt(z) * Math.sqrt(Math.max(0, k * (2 - k)));
    },
  };
}

/** Point on the canopy shell. φ = 0 starboard sill → π/2 crown → π port sill. */
function shellPoint(
  st: Stn[], prof: FuselageProfile, i: number, phi: number, out: THREE.Vector3,
): THREE.Vector3 {
  const s = st[i];
  const e = 2 / s.n;
  const sill = prof.topY(s.z) - 0.015;
  out.set(
    s.w * sgnpow(Math.cos(phi), e),
    sill + s.h * sgnpow(Math.sin(phi), e),
    s.z,
  );
  return out;
}

export function buildCanopy(
  spec: AircraftSpec, prof: FuselageProfile, detail: number, frameBox: UvBox,
): CanopyResult {
  const st = stations(spec, prof);
  const bubble = bubbleCanopy(spec);
  const arcSeg = detail === 0 ? 14 : detail === 1 ? 8 : 5;
  const v = new THREE.Vector3();

  // --- glazing --------------------------------------------------------------
  const b = new MeshBuilder();
  const rows = b.addGrid(st.length, arcSeg + 1, (i, j, o) => {
    const phi = (j / arcSeg) * Math.PI;
    shellPoint(st, prof, i, phi, v);
    o.x = v.x; o.y = v.y; o.z = v.z;
    // Planar 0..1 unwrap: the specular-streak map is authored in this space.
    o.u = j / arcSeg;
    o.v = st[i].t;
  });
  // Close the front and rear so the glass is a shell rather than a sheet.
  shellPoint(st, prof, 0, Math.PI * 0.5, v);
  const cf = b.vert(v.x - 0, v.y - st[0].h * 0.5, v.z, 0.5, 0);
  b.fan(cf, rows[0], true);
  const glass = b.build(true);

  // --- frames ---------------------------------------------------------------
  const frames: THREE.BufferGeometry[] = [];
  // Canopy framing is 25–30 mm extruded section on the real aircraft; anything
  // thicker turns the greenhouse into a roll cage.
  const rTube = Math.max(0.011, spec.geom.fuseRadius * 0.019);

  const sweepArc = (i: number, phi0: number, phi1: number, r: number, n: number) => {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= n; k++) {
      const phi = phi0 + (phi1 - phi0) * (k / n);
      pts.push(shellPoint(st, prof, i, phi, new THREE.Vector3()).clone());
    }
    frames.push(tubeGeom(pts, () => r, detail === 0 ? 6 : 4, frameBox, true));
  };

  const sweepRail = (phi: number, i0: number, i1: number, r: number) => {
    const pts: THREE.Vector3[] = [];
    for (let i = i0; i <= i1; i++) pts.push(shellPoint(st, prof, i, phi, new THREE.Vector3()).clone());
    frames.push(tubeGeom(pts, () => r, detail === 0 ? 6 : 4, frameBox, true));
  };

  // Station indices into the table above: 3 is the windscreen arch, 6 the rear
  // bow of the sliding hood.
  const ARCH = 3, HOOD_BOW = 5, REAR_BOW = 6;
  // Sill rails down both sides, full length.
  sweepRail(0.02, 0, st.length - 1, rTube * 1.15);
  sweepRail(Math.PI - 0.02, 0, st.length - 1, rTube * 1.15);
  // Windscreen arch — the heavy one, on every type.
  sweepArc(ARCH, 0.02, Math.PI - 0.02, rTube * 1.5, arcSeg);
  // Windscreen posts: a centre post and two quarter-panel divisions on a framed
  // greenhouse; a bubble hood has only the centre post of the flat front panel.
  const posts = bubble ? [Math.PI * 0.5] : [Math.PI * 0.5, Math.PI * 0.24, Math.PI * 0.76];
  for (const phi of posts) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= ARCH; i++) pts.push(shellPoint(st, prof, i, phi, new THREE.Vector3()).clone());
    frames.push(tubeGeom(pts, () => rTube * (phi === Math.PI * 0.5 ? 1.25 : 0.8), detail === 0 ? 6 : 4, frameBox, true));
  }
  // Hood bows: a framed canopy has them, a blown teardrop has none at all.
  if (!bubble) {
    if (detail === 0) sweepArc(HOOD_BOW, 0.02, Math.PI - 0.02, rTube * 0.85, arcSeg);
    sweepArc(REAR_BOW, 0.02, Math.PI - 0.02, rTube * 1.25, arcSeg);
  }

  return {
    glass,
    frame: mergeGeoms(frames),
    rearZ: st[st.length - 1].z,
    centreZ: (spec.geom.canopy.z0 + spec.geom.canopy.z1) * 0.5,
    sillY: prof.topY((spec.geom.canopy.z0 + spec.geom.canopy.z1) * 0.5),
  };
}

// ---------------------------------------------------------------------------
// Glass specular streak map
// ---------------------------------------------------------------------------

/**
 * Emissive map for the canopy: two hard-edged diagonal bands.
 *
 * The cel material's specular is an isotropic Blinn lobe, which cannot make the
 * long anisotropic glare that a formed perspex canopy throws. Painting the
 * streak in and driving it through the emissive channel gives the stepped
 * highlight the art direction asks for, and because it is anchored to the
 * canopy's own UVs it slides across the glass as the aircraft rolls rather than
 * sticking to the screen.
 */
export function makeGlassStreakTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  if (!g) throw new Error('[assets] canvas unavailable');
  g.fillStyle = '#000000';
  g.fillRect(0, 0, S, S);
  g.save();
  g.translate(S * 0.5, S * 0.5);
  g.rotate(-0.62);
  const bands: [number, number, number][] = [[-S * 0.30, S * 0.055, 0.95], [-S * 0.14, S * 0.022, 0.6], [S * 0.16, S * 0.030, 0.35]];
  for (const [y, h, a] of bands) {
    const grd = g.createLinearGradient(-S, 0, S, 0);
    grd.addColorStop(0.0, `rgba(255,255,255,0)`);
    grd.addColorStop(0.25, `rgba(255,255,255,${a})`);
    grd.addColorStop(0.72, `rgba(255,255,255,${a * 0.8})`);
    grd.addColorStop(1.0, `rgba(255,255,255,0)`);
    g.fillStyle = grd;
    g.fillRect(-S, y - h * 0.5, S * 2, h);
  }
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
