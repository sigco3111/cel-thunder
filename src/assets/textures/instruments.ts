/**
 * Instrument dial faces, generated as a 4×4 atlas of 128 px tiles.
 *
 * Faces only — every needle is real geometry parented to a pivot at the dial
 * centre, so the HUD system can drive them. Dial layouts follow the standard
 * WWII fighter panel: the "blind flying" six in the middle, engine instruments
 * to the right, and a couple of placards.
 */

import * as THREE from 'three';
import { GAUGE_TEX_SIZE, GAUGE_TILES } from './atlas';
import type { GaugeName } from './atlas';
import { drawText, hex, makeCanvas, ctx2d, rgba, Rand } from './canvas2d';
import type { Ctx2D } from './canvas2d';

const FACE = 0x121415;
const MARK = 0xe6e3d8;
const WARN = 0xc23a2c;
const CAUTION = 0xd9a72c;

function bezel(g: Ctx2D, cx: number, cy: number, r: number): void {
  // Chromed bezel ring with a lit top edge — reads as glass even at 128 px.
  const grd = g.createLinearGradient(cx, cy - r, cx, cy + r);
  grd.addColorStop(0, '#8f959b');
  grd.addColorStop(0.45, '#4a4f54');
  grd.addColorStop(1, '#23262a');
  g.fillStyle = grd;
  g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fill();
  g.fillStyle = hex(FACE);
  g.beginPath(); g.arc(cx, cy, r * 0.86, 0, 6.2832); g.fill();
  // Glass reflection: a hard crescent, not a soft blob.
  g.save();
  g.beginPath(); g.arc(cx, cy, r * 0.86, 0, 6.2832); g.clip();
  g.fillStyle = 'rgba(210,225,240,0.10)';
  g.beginPath();
  g.ellipse(cx - r * 0.28, cy - r * 0.36, r * 0.62, r * 0.34, -0.6, 0, 6.2832);
  g.fill();
  g.restore();
}

interface DialOpts {
  /** Sweep start/end angles measured clockwise from 12 o'clock, in radians. */
  a0: number;
  a1: number;
  major: number;
  minor: number;
  labels: string[];
  label: string;
  sub?: string;
  /** Red arc as [fraction start, fraction end]. */
  redArc?: [number, number];
  yellowArc?: [number, number];
}

function dial(g: Ctx2D, cx: number, cy: number, r: number, o: DialOpts): void {
  bezel(g, cx, cy, r);
  const ang = (f: number) => -Math.PI / 2 + o.a0 + (o.a1 - o.a0) * f;

  if (o.yellowArc) {
    g.strokeStyle = rgba(CAUTION, 0.85); g.lineWidth = r * 0.075;
    g.beginPath(); g.arc(cx, cy, r * 0.70, ang(o.yellowArc[0]), ang(o.yellowArc[1])); g.stroke();
  }
  if (o.redArc) {
    g.strokeStyle = rgba(WARN, 0.9); g.lineWidth = r * 0.075;
    g.beginPath(); g.arc(cx, cy, r * 0.70, ang(o.redArc[0]), ang(o.redArc[1])); g.stroke();
  }

  const total = o.major * o.minor;
  for (let i = 0; i <= total; i++) {
    const f = i / total;
    const a = ang(f);
    const isMajor = i % o.minor === 0;
    const r0 = r * (isMajor ? 0.60 : 0.70);
    const r1 = r * 0.79;
    g.strokeStyle = rgba(MARK, isMajor ? 0.95 : 0.6);
    g.lineWidth = isMajor ? r * 0.045 : r * 0.022;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    g.stroke();
  }
  o.labels.forEach((t, i) => {
    const f = i / Math.max(1, o.labels.length - 1);
    const a = ang(f);
    drawText(g, t, cx + Math.cos(a) * r * 0.47, cy + Math.sin(a) * r * 0.47, {
      size: r * 0.19, color: MARK, align: 'center', weight: 700, squash: 0.9,
    });
  });
  drawText(g, o.label, cx, cy + r * 0.30, { size: r * 0.15, color: 0xa8a496, align: 'center', weight: 600, squash: 0.85 });
  if (o.sub) drawText(g, o.sub, cx, cy - r * 0.34, { size: r * 0.13, color: 0x8d8a7e, align: 'center', weight: 600, squash: 0.85 });
}

function horizon(g: Ctx2D, cx: number, cy: number, r: number): void {
  bezel(g, cx, cy, r);
  g.save();
  g.beginPath(); g.arc(cx, cy, r * 0.80, 0, 6.2832); g.clip();
  g.fillStyle = '#2a5b86'; g.fillRect(cx - r, cy - r, r * 2, r);
  g.fillStyle = '#6b4a2a'; g.fillRect(cx - r, cy, r * 2, r);
  g.strokeStyle = rgba(MARK, 0.9); g.lineWidth = r * 0.035;
  g.beginPath(); g.moveTo(cx - r * 0.8, cy); g.lineTo(cx + r * 0.8, cy); g.stroke();
  for (let i = 1; i <= 3; i++) {
    const w = r * (0.30 - i * 0.05);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx - w, cy + s * i * r * 0.17);
      g.lineTo(cx + w, cy + s * i * r * 0.17);
      g.stroke();
    }
  }
  g.restore();
  // Fixed aircraft symbol.
  g.strokeStyle = hex(CAUTION); g.lineWidth = r * 0.06;
  g.beginPath();
  g.moveTo(cx - r * 0.52, cy); g.lineTo(cx - r * 0.16, cy);
  g.moveTo(cx + r * 0.16, cy); g.lineTo(cx + r * 0.52, cy);
  g.stroke();
  g.beginPath(); g.arc(cx, cy, r * 0.055, 0, 6.2832); g.stroke();
}

function turnSlip(g: Ctx2D, cx: number, cy: number, r: number): void {
  bezel(g, cx, cy, r);
  g.strokeStyle = rgba(MARK, 0.85); g.lineWidth = r * 0.04;
  for (const s of [-1, 1]) {
    const a = -Math.PI / 2 + s * 0.42;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55);
    g.lineTo(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78);
    g.stroke();
  }
  // Slip ball race.
  g.strokeStyle = rgba(MARK, 0.7); g.lineWidth = r * 0.05;
  g.beginPath(); g.arc(cx, cy - r * 1.15, r * 1.55, 1.25, 1.89); g.stroke();
  drawText(g, 'TURN', cx, cy + r * 0.30, { size: r * 0.15, color: 0xa8a496, align: 'center', weight: 600 });
}

function compass(g: Ctx2D, cx: number, cy: number, r: number): void {
  bezel(g, cx, cy, r);
  const pts = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];
  pts.forEach((t, i) => {
    const a = -Math.PI / 2 + (i / 12) * Math.PI * 2;
    drawText(g, t, cx + Math.cos(a) * r * 0.58, cy + Math.sin(a) * r * 0.58, {
      size: r * (t.length === 1 ? 0.22 : 0.16), color: MARK, align: 'center', weight: 700,
    });
  });
  g.strokeStyle = hex(CAUTION); g.lineWidth = r * 0.05;
  g.beginPath(); g.moveTo(cx, cy - r * 0.85); g.lineTo(cx, cy - r * 0.62); g.stroke();
}

function placard(g: Ctx2D, x: number, y: number, s: number, rnd: Rand): void {
  g.fillStyle = '#1b1d1f';
  g.fillRect(x + s * 0.08, y + s * 0.20, s * 0.84, s * 0.60);
  g.strokeStyle = 'rgba(180,178,166,0.5)';
  g.lineWidth = 1.5;
  g.strokeRect(x + s * 0.08, y + s * 0.20, s * 0.84, s * 0.60);
  const lines = ['FUEL COCK', 'MAIN — RESERVE', `LIMIT ${400 + rnd.int(9) * 10} MPH`];
  lines.forEach((t, i) => {
    drawText(g, t, x + s * 0.5, y + s * 0.32 + i * s * 0.17, {
      size: s * 0.10, color: 0xd4d0c2, align: 'center', weight: 600, squash: 0.9,
    });
  });
}

export interface GaugeAtlas {
  texture: THREE.CanvasTexture;
  dispose(): void;
}

export function buildGaugeAtlas(seed = 1): GaugeAtlas {
  const S = GAUGE_TEX_SIZE;
  const c = makeCanvas(S, S);
  const g = ctx2d(c);
  const rnd = new Rand(seed);
  g.fillStyle = '#0b0c0d';
  g.fillRect(0, 0, S, S);

  const tile = S / 4;
  const r = tile * 0.42;
  GAUGE_TILES.forEach((name, i) => {
    const cx = (i % 4) * tile + tile / 2;
    const cy = ((i / 4) | 0) * tile + tile / 2;
    drawTile(g, name, cx, cy, r, tile, rnd);
  });

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return { texture, dispose() { texture.dispose(); } };
}

function drawTile(g: Ctx2D, name: GaugeName, cx: number, cy: number, r: number, tile: number, rnd: Rand): void {
  const A = 0.35, B = Math.PI * 2 - 0.35;   // 320° sweep, the usual layout
  switch (name) {
    case 'airspeed':
      dial(g, cx, cy, r, { a0: A, a1: B, major: 8, minor: 5, labels: ['0', '10', '20', '30', '40', '50', '60', '70', '80'], label: 'A.S.I.', sub: 'MPH', redArc: [0.92, 1] });
      break;
    case 'altimeter':
      dial(g, cx, cy, r, { a0: 0, a1: Math.PI * 2, major: 10, minor: 5, labels: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], label: 'ALT', sub: '1000 FT' });
      break;
    case 'horizon': horizon(g, cx, cy, r); break;
    case 'turnslip': turnSlip(g, cx, cy, r); break;
    case 'vsi':
      dial(g, cx, cy, r, { a0: -Math.PI * 0.78, a1: Math.PI * 0.78, major: 8, minor: 5, labels: ['4', '2', '1', '0', '1', '2', '4'], label: 'CLIMB', sub: '1000 FT/M' });
      break;
    case 'compass': compass(g, cx, cy, r); break;
    case 'rpm':
      dial(g, cx, cy, r, { a0: A, a1: B, major: 8, minor: 5, labels: ['0', '5', '10', '15', '20', '25', '30', '35', '40'], label: 'R.P.M.', sub: '×100', redArc: [0.86, 1], yellowArc: [0.74, 0.86] });
      break;
    case 'boost':
      dial(g, cx, cy, r, { a0: A, a1: B, major: 6, minor: 4, labels: ['-8', '-4', '0', '+4', '+8', '+12', '+16'], label: 'BOOST', sub: 'LB/IN²', redArc: [0.88, 1] });
      break;
    case 'oiltemp':
      dial(g, cx, cy, r, { a0: A, a1: Math.PI * 0.9, major: 5, minor: 4, labels: ['0', '40', '80', '120'], label: 'OIL TEMP', sub: '°C', redArc: [0.85, 1] });
      break;
    case 'oilpress':
      dial(g, cx, cy, r, { a0: A, a1: Math.PI * 0.9, major: 5, minor: 4, labels: ['0', '30', '60', '90'], label: 'OIL PRESS', sub: 'LB/IN²' });
      break;
    case 'fuel':
      dial(g, cx, cy, r, { a0: -Math.PI * 0.6, a1: Math.PI * 0.6, major: 4, minor: 4, labels: ['E', '¼', '½', '¾', 'F'], label: 'FUEL', redArc: [0, 0.12] });
      break;
    case 'clock':
      dial(g, cx, cy, r, { a0: 0, a1: Math.PI * 2, major: 12, minor: 5, labels: ['12', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'], label: '' });
      break;
    case 'ammo':
      dial(g, cx, cy, r, { a0: -Math.PI * 0.55, a1: Math.PI * 0.55, major: 4, minor: 5, labels: ['0', '', '', '', 'MAX'], label: 'ROUNDS', redArc: [0, 0.15] });
      break;
    case 'radiator':
      dial(g, cx, cy, r, { a0: -Math.PI * 0.5, a1: Math.PI * 0.5, major: 4, minor: 2, labels: ['SHUT', '', '', '', 'OPEN'], label: 'RAD' });
      break;
    case 'placard': placard(g, cx - tile / 2, cy - tile / 2, tile, rnd); break;
    default:
      bezel(g, cx, cy, r);
      break;
  }
}
