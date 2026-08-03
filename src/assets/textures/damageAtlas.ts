/**
 * Battle-damage decal atlas: 4×4 tiles of 256 px, RGBA with a transparent
 * background, applied as small quads on the hull where rounds land.
 *
 * The anatomy of each decal matters more than its randomness. A rifle-calibre
 * hit is a small dark aperture with a *bright* ring of torn, un-painted metal
 * around it and a thin sooty halo — the bright ring is what makes it read at
 * distance against dark camouflage. A cannon shell makes a ragged blow-out with
 * petals of skin peeled back, which means large light triangles with dark
 * shadows on their downstream side. Scorch is soft and directional. Everything
 * is drawn with a strong value contrast because a subtle bullet hole is an
 * invisible bullet hole.
 */

import * as THREE from 'three';
import { DAMAGE_TEX_SIZE, DAMAGE_TILES } from './atlas';
import type { DamageDecal } from './atlas';
import { Rand, ctx2d, makeCanvas, polyPath, rgba, softBlob } from './canvas2d';
import type { Ctx2D } from './canvas2d';

const METAL_HI = 0xd6dade;
const METAL_MID = 0x9aa0a6;
const METAL_LO = 0x4a4f54;
const SOOT = 0x14120f;

function jaggedPath(g: Ctx2D, cx: number, cy: number, r: number, n: number, rough: number, rnd: Rand): void {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 + rnd.gauss(rough));
    pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  polyPath(g, pts);
}

/** Petals of skin peeled back around an entry or exit hole. */
function petals(
  g: Ctx2D, cx: number, cy: number, rIn: number, rOut: number, n: number, rnd: Rand, bright: number,
): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd.gauss(0.12);
    const w = (Math.PI / n) * rnd.range(0.55, 1.05);
    const len = rOut * rnd.range(0.6, 1.25);
    const x0 = cx + Math.cos(a - w) * rIn, y0 = cy + Math.sin(a - w) * rIn;
    const x1 = cx + Math.cos(a + w) * rIn, y1 = cy + Math.sin(a + w) * rIn;
    const x2 = cx + Math.cos(a) * len, y2 = cy + Math.sin(a) * len;
    g.fillStyle = rgba(bright, rnd.range(0.55, 0.95));
    polyPath(g, [x0, y0, x1, y1, x2, y2]);
    g.fill();
    // Shadow on one flank gives the petal thickness.
    g.fillStyle = rgba(SOOT, 0.42);
    polyPath(g, [x1, y1, x2, y2, x1 + (x2 - x1) * 0.25, y1 + (y2 - y1) * 0.25]);
    g.fill();
  }
}

function bulletHole(g: Ctx2D, cx: number, cy: number, s: number, rnd: Rand, exit: boolean): void {
  const rHole = s * (exit ? 0.20 : 0.13);
  // Soot halo first so everything else sits on top of it.
  softBlob(g, cx, cy, s * 0.52, rgba(SOOT, 0.42), 1, 0.05);
  petals(g, cx, cy, rHole * 1.05, rHole * (exit ? 3.0 : 2.1), exit ? 9 : 7, rnd, METAL_HI);
  // Bright lip ring.
  g.strokeStyle = rgba(METAL_HI, 0.9);
  g.lineWidth = s * 0.022;
  jaggedPath(g, cx, cy, rHole * 1.22, 14, 0.14, rnd);
  g.stroke();
  // The aperture.
  g.fillStyle = rgba(0x05060700, 1);
  g.fillStyle = 'rgba(6,6,7,0.97)';
  jaggedPath(g, cx, cy, rHole, 12, 0.16, rnd);
  g.fill();
  // Radial stress scratches into the surrounding paint.
  for (let i = 0; i < 14; i++) {
    const a = rnd.next() * Math.PI * 2;
    const l = s * rnd.range(0.18, 0.44);
    g.strokeStyle = rgba(METAL_MID, rnd.range(0.15, 0.5));
    g.lineWidth = rnd.range(0.6, 1.8);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * rHole * 1.3, cy + Math.sin(a) * rHole * 1.3);
    g.lineTo(cx + Math.cos(a) * (rHole * 1.3 + l), cy + Math.sin(a) * (rHole * 1.3 + l));
    g.stroke();
  }
}

function cannonBlowout(g: Ctx2D, cx: number, cy: number, s: number, rnd: Rand): void {
  softBlob(g, cx, cy, s * 0.62, rgba(SOOT, 0.55), 1, 0.02);
  const rHole = s * 0.28;
  petals(g, cx, cy, rHole * 0.95, rHole * 2.0, 11, rnd, METAL_MID);
  // Ragged void with internal structure showing through.
  g.fillStyle = 'rgba(9,9,10,0.98)';
  jaggedPath(g, cx, cy, rHole, 18, 0.24, rnd);
  g.fill();
  g.fillStyle = rgba(METAL_LO, 0.7);
  jaggedPath(g, cx + s * 0.03, cy + s * 0.03, rHole * 0.55, 10, 0.3, rnd);
  g.fill();
  // Skin buckling around the blast.
  for (let i = 0; i < 22; i++) {
    const a = rnd.next() * Math.PI * 2;
    const r0 = rHole * rnd.range(1.4, 1.8);
    const l = s * rnd.range(0.10, 0.36);
    g.strokeStyle = rgba(i % 2 ? METAL_HI : SOOT, rnd.range(0.20, 0.55));
    g.lineWidth = rnd.range(1.2, 3.4);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * (r0 + l), cy + Math.sin(a) * (r0 + l));
    g.stroke();
  }
}

function scorch(g: Ctx2D, cx: number, cy: number, s: number, rnd: Rand, dirX: number): void {
  for (let i = 0; i < 26; i++) {
    const t = i / 26;
    const x = cx + dirX * t * s * 0.42 + rnd.gauss(s * 0.05);
    const y = cy + rnd.gauss(s * 0.07);
    softBlob(g, x, y, s * (0.30 - t * 0.14), rgba(SOOT, 0.13 * (1 - t * 0.6)), 1, 0.0);
  }
  for (let i = 0; i < 18; i++) {
    const a = rnd.range(-0.5, 0.5);
    const l = s * rnd.range(0.15, 0.44);
    g.strokeStyle = rgba(SOOT, rnd.range(0.1, 0.3));
    g.lineWidth = rnd.range(1, 4);
    g.beginPath();
    g.moveTo(cx, cy + rnd.gauss(s * 0.08));
    g.lineTo(cx + dirX * l * Math.cos(a), cy + l * Math.sin(a));
    g.stroke();
  }
}

function tear(g: Ctx2D, cx: number, cy: number, s: number, rnd: Rand): void {
  // A long rip in the skin with the edge lifted along one side.
  const n = 9;
  const up: number[] = [], dn: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = cx + (t - 0.5) * s * 0.78;
    const y = cy + Math.sin(t * 4.2) * s * 0.045 + rnd.gauss(s * 0.012);
    up.push(x, y - s * 0.025 * (0.4 + rnd.next()));
    dn.unshift(x, y + s * 0.025 * (0.4 + rnd.next()));
  }
  g.fillStyle = 'rgba(8,8,9,0.94)';
  polyPath(g, up.concat(dn));
  g.fill();
  g.strokeStyle = rgba(METAL_HI, 0.75);
  g.lineWidth = s * 0.014;
  g.beginPath();
  g.moveTo(up[0], up[1]);
  for (let i = 2; i < up.length; i += 2) g.lineTo(up[i], up[i + 1]);
  g.stroke();
  softBlob(g, cx, cy, s * 0.34, rgba(SOOT, 0.25), 1, 0.1);
}

function crack(g: Ctx2D, cx: number, cy: number, s: number, rnd: Rand): void {
  const walk = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
    let px = x, py = y, pa = a;
    g.strokeStyle = rgba(0x0d0d0e, 0.8);
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(px, py);
    const steps = 7;
    for (let i = 0; i < steps; i++) {
      pa += rnd.gauss(0.32);
      px += Math.cos(pa) * (len / steps);
      py += Math.sin(pa) * (len / steps);
      g.lineTo(px, py);
    }
    g.stroke();
    if (depth > 0) {
      walk(px, py, pa + rnd.range(0.5, 1.1), len * 0.55, w * 0.6, depth - 1);
      walk(px, py, pa - rnd.range(0.5, 1.1), len * 0.55, w * 0.6, depth - 1);
    }
  };
  for (let i = 0; i < 3; i++) walk(cx, cy, rnd.next() * 6.28, s * 0.3, 2.4, 2);
}

function oilSplat(g: Ctx2D, cx: number, cy: number, s: number, rnd: Rand): void {
  for (let i = 0; i < 30; i++) {
    const t = rnd.next();
    const x = cx - s * 0.35 + t * s * 0.7 + rnd.gauss(s * 0.05);
    const y = cy + rnd.gauss(s * 0.14);
    g.fillStyle = rgba(0x120e08, rnd.range(0.15, 0.55));
    g.beginPath();
    g.ellipse(x, y, s * rnd.range(0.02, 0.10), s * rnd.range(0.01, 0.05), 0, 0, 6.2832);
    g.fill();
  }
  softBlob(g, cx, cy, s * 0.4, rgba(0x120e08, 0.35), 1, 0.05);
}

export interface DamageAtlas {
  texture: THREE.CanvasTexture;
  dispose(): void;
}

export function buildDamageAtlas(seed = 7): DamageAtlas {
  const S = DAMAGE_TEX_SIZE;
  const c = makeCanvas(S, S);
  const g = ctx2d(c);
  const rnd = new Rand(seed);
  const tile = S / 4;

  DAMAGE_TILES.forEach((name, i) => {
    const cx = (i % 4) * tile + tile / 2;
    const cy = ((i / 4) | 0) * tile + tile / 2;
    drawDecal(g, name, cx, cy, tile, rnd);
  });

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return { texture, dispose() { texture.dispose(); } };
}

function drawDecal(g: Ctx2D, name: DamageDecal, cx: number, cy: number, s: number, rnd: Rand): void {
  switch (name) {
    case 'hole_a': case 'hole_b': case 'hole_c': case 'hole_d':
      bulletHole(g, cx, cy, s, rnd, false); break;
    case 'exit_a': case 'exit_b':
      bulletHole(g, cx, cy, s, rnd, true); break;
    case 'cannon_a': case 'cannon_b': case 'cannon_c':
      cannonBlowout(g, cx, cy, s, rnd); break;
    case 'scorch_a': scorch(g, cx, cy, s, rnd, 1); break;
    case 'scorch_b': scorch(g, cx, cy, s, rnd, -1); break;
    case 'scorch_c': scorch(g, cx, cy, s, rnd, 0.2); break;
    case 'tear_a': case 'tear_b': tear(g, cx, cy, s, rnd); break;
    case 'crack': crack(g, cx, cy, s, rnd); break;
    case 'oil': oilSplat(g, cx, cy, s, rnd); break;
    default: break;
  }
}
