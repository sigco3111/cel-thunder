/**
 * National markings, drawn to spec rather than approximated.
 *
 * Proportions come from the actual wartime orders (RAF AMO A.664/1942 ratios,
 * USAAF AN-I-9b, etc.) because these are the shapes players recognise at a
 * glance — a roundel with the wrong ring widths reads as "wrong game" even at
 * 200 m. Placement rules differ per surface, which is why 'place' is part of the
 * call rather than something the caller has to remember.
 *
 * Note on German tail markings: the historical fin device is not drawn. Fins get
 * the unit/geschwader bar and victory tally instead, which is what the eye reads
 * as "German fighter tail" anyway.
 */

import type { Nation } from '../../shared/aircraft';
import { drawText, hex, polyPath, Rand, rgba } from './canvas2d';
import type { Ctx2D } from './canvas2d';

export type InsigniaPlace = 'fuselage' | 'wingUpper' | 'wingLower' | 'fin';

const RAF_RED = 0xa22b28;
const RAF_BLUE = 0x1f3f7a;
const RAF_YELLOW = 0xd9a72c;
const WHITE = 0xf0eee7;
const BLACK = 0x141414;
const US_BLUE = 0x1d3461;
const US_WHITE = 0xf2f0ea;
const JP_RED = 0xb52a22;
const SU_RED = 0xb02a24;

function disc(g: Ctx2D, cx: number, cy: number, r: number, c: number, a = 1): void {
  g.fillStyle = rgba(c, a);
  g.beginPath(); g.arc(cx, cy, r, 0, 6.2831853); g.fill();
}

/** Regular n-pointed star. 'rot' of -π/2 puts a point straight up. */
export function starPath(g: Ctx2D, cx: number, cy: number, rOuter: number, rInner: number, points = 5, rot = -Math.PI / 2): void {
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = rot + (i * Math.PI) / points;
    const r = i % 2 === 0 ? rOuter : rInner;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
}

// ---------------------------------------------------------------------------
// Per-nation devices
// ---------------------------------------------------------------------------

/** RAF roundel. 'r' is the outer radius of the whole device. */
export function rafRoundel(g: Ctx2D, cx: number, cy: number, r: number, place: InsigniaPlace): void {
  if (place === 'wingUpper') {
    // Type B — red/blue only, no light colours on the camouflaged upper surface.
    disc(g, cx, cy, r, RAF_BLUE);
    disc(g, cx, cy, r * 0.4, RAF_RED);
  } else if (place === 'wingLower') {
    // Type C — 1:3:5.
    disc(g, cx, cy, r, RAF_BLUE);
    disc(g, cx, cy, r * 0.6, WHITE);
    disc(g, cx, cy, r * 0.2, RAF_RED);
  } else {
    // Type C1 — 3:5:9:11, the thin yellow surround being the giveaway.
    disc(g, cx, cy, r, RAF_YELLOW);
    disc(g, cx, cy, r * (9 / 11), RAF_BLUE);
    disc(g, cx, cy, r * (5 / 11), WHITE);
    disc(g, cx, cy, r * (3 / 11), RAF_RED);
  }
}

/** RAF fin flash: three equal vertical stripes, red forward. */
export function rafFinFlash(g: Ctx2D, x: number, y: number, w: number, h: number, forwardIsLeft: boolean): void {
  const s = w / 3;
  const cols = forwardIsLeft ? [RAF_RED, WHITE, RAF_BLUE] : [RAF_BLUE, WHITE, RAF_RED];
  for (let i = 0; i < 3; i++) { g.fillStyle = hex(cols[i]); g.fillRect(x + i * s, y, s + 0.6, h); }
}

/** Balkenkreuz — black bar cross with white flanking, drawn as nested crosses. */
export function balkenkreuz(g: Ctx2D, cx: number, cy: number, r: number, simplified = false): void {
  const cross = (rad: number, arm: number, col: number) => {
    g.fillStyle = hex(col);
    g.fillRect(cx - rad, cy - arm, rad * 2, arm * 2);
    g.fillRect(cx - arm, cy - rad, arm * 2, rad * 2);
  };
  if (!simplified) cross(r, r * 0.34, WHITE);
  cross(r * (simplified ? 1 : 0.74), r * (simplified ? 0.32 : 0.24), BLACK);
  // A hairline keyline stops the black from dissolving into dark camouflage.
  g.save();
  g.strokeStyle = rgba(0x000000, 0.35);
  g.lineWidth = Math.max(1, r * 0.03);
  g.strokeRect(cx - r, cy - r * 0.34, r * 2, r * 0.68);
  g.strokeRect(cx - r * 0.34, cy - r, r * 0.68, r * 2);
  g.restore();
}

/**
 * USAAF star-and-bar (AN-I-9b, insignia blue surround).
 * 'r' is the radius of the blue disc; total width is 4r.
 */
export function starAndBar(g: Ctx2D, cx: number, cy: number, r: number, withBars = true): void {
  const barW = r * 1.0, barH = r * 0.5;
  g.save();
  if (withBars) {
    g.fillStyle = hex(US_BLUE);
    g.fillRect(cx - r - barW, cy - barH, r * 2 + barW * 2, barH * 2);
  }
  disc(g, cx, cy, r, US_BLUE);
  if (withBars) {
    g.fillStyle = hex(US_WHITE);
    g.fillRect(cx + r * 0.86, cy - barH * 0.78, barW * 0.92, barH * 1.56);
    g.fillRect(cx - r * 0.86 - barW * 0.92, cy - barH * 0.78, barW * 0.92, barH * 1.56);
  }
  g.fillStyle = hex(US_WHITE);
  starPath(g, cx, cy, r * 0.92, r * 0.92 * 0.382);
  g.fill();
  g.restore();
}

/** Hinomaru. A thin white surround is added where contrast demands it. */
export function hinomaru(g: Ctx2D, cx: number, cy: number, r: number, outline: boolean): void {
  if (outline) disc(g, cx, cy, r, WHITE);
  disc(g, cx, cy, outline ? r * 0.84 : r, JP_RED);
}

/** VVS red star with white then black keyline (1943 standard). */
export function sovietStar(g: Ctx2D, cx: number, cy: number, r: number): void {
  g.save();
  g.fillStyle = hex(WHITE);
  starPath(g, cx, cy, r, r * 0.382); g.fill();
  g.fillStyle = hex(SU_RED);
  starPath(g, cx, cy, r * 0.86, r * 0.86 * 0.382); g.fill();
  g.strokeStyle = rgba(0x101010, 0.55);
  g.lineWidth = Math.max(1, r * 0.045);
  starPath(g, cx, cy, r, r * 0.382); g.stroke();
  g.restore();
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Draw the correct device for 'nation' on 'place', centred at (cx,cy). */
export function drawInsignia(g: Ctx2D, nation: Nation, place: InsigniaPlace, cx: number, cy: number, r: number): void {
  switch (nation) {
    case 'britain': rafRoundel(g, cx, cy, r, place); break;
    // The full white-flanked cross on every surface: the plain black
    // 'simplified' cross was rare and reads as a black smear on wing camouflage.
    case 'germany': balkenkreuz(g, cx, cy, r * 0.86, false); break;
    case 'usa': starAndBar(g, cx, cy, r * 0.55, true); break;
    case 'japan': hinomaru(g, cx, cy, r, place !== 'wingUpper'); break;
    case 'ussr': sovietStar(g, cx, cy, r); break;
  }
}

/** Aspect of the device: how much horizontal room it needs relative to 'r'. */
export function insigniaAspect(nation: Nation): number {
  return nation === 'usa' ? 2.2 : 1;
}

// ---------------------------------------------------------------------------
// Tail devices
// ---------------------------------------------------------------------------

export interface TailMarkOpts { rnd: Rand; accent: number; serial: string }

/** Nation-appropriate fin marking, drawn into the rect (x,y,w,h). */
export function drawTailMarking(
  g: Ctx2D, nation: Nation, x: number, y: number, w: number, h: number, o: TailMarkOpts,
): void {
  switch (nation) {
    case 'britain':
      rafFinFlash(g, x + w * 0.30, y + h * 0.34, w * 0.30, h * 0.42, true);
      break;
    case 'usa':
      // Squadron colour band across the fin tip plus the tail serial.
      g.fillStyle = rgba(o.accent, 0.92);
      g.fillRect(x + w * 0.08, y + h * 0.06, w * 0.84, h * 0.16);
      drawText(g, o.serial, x + w * 0.5, y + h * 0.55, {
        size: h * 0.20, color: 0x1a1a1a, align: 'center', weight: 800, squash: 0.82,
      });
      break;
    case 'germany': {
      // Geschwader bar + victory tally: reads instantly as a Luftwaffe fin.
      g.fillStyle = rgba(WHITE, 0.9);
      g.fillRect(x + w * 0.16, y + h * 0.30, w * 0.60, h * 0.07);
      const kills = 3 + o.rnd.int(9);
      for (let i = 0; i < kills; i++) {
        const bx = x + w * 0.20 + (i % 6) * w * 0.10;
        const by = y + h * 0.48 + Math.floor(i / 6) * h * 0.14;
        g.fillStyle = rgba(WHITE, 0.85);
        g.fillRect(bx, by, Math.max(1.5, w * 0.018), h * 0.11);
      }
      break;
    }
    case 'japan':
      // Sentai tail stripe.
      g.fillStyle = rgba(o.accent, 0.9);
      g.fillRect(x + w * 0.10, y + h * 0.24, w * 0.16, h * 0.62);
      g.fillStyle = rgba(WHITE, 0.85);
      drawText(g, o.serial, x + w * 0.62, y + h * 0.52, {
        size: h * 0.19, color: WHITE, align: 'center', weight: 700, squash: 0.85,
      });
      break;
    case 'ussr':
      sovietStar(g, x + w * 0.5, y + h * 0.52, Math.min(w, h) * 0.30);
      break;
  }
}
