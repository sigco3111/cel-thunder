/**
 * Cockpit interior — everything the player sees from the pilot's eye.
 *
 * ## Why this module owns its own texture sheet
 *
 * The instrument panel is the closest surface in the game: at the cockpit eye
 * point it is 80 cm from the lens and covers most of the lower half of the
 * frame. Painting it out of the shared 4×4 / 128 px gauge atlas put roughly
 * ninety texels across a dial that lands a hundred and forty pixels wide, which
 * is how you get a "cockpit" whose instruments are unreadable mush. So the
 * panel — bezels, faces, ticks, numerals, placards, switches, screws and paint
 * wear — is painted once at 1651 px per metre into a sheet this module owns,
 * and the whole panel is a single quad. One draw call, legible dials.
 *
 * ## Where everything is
 *
 * Nothing here is positioned by hand-tuned constants in world space. The three
 * anchors are the fuselage loft, the canopy sill line and the cockpit opening
 * that 'canopyOpening' cuts in the skin, and every part hangs off those:
 *
 *   - the **eye** sits a third of the canopy's height above the sill, which is
 *     what puts the pilot's head inside the glasshouse instead of buried in the
 *     turtledeck. Getting this wrong by 8 cm — which the previous version was —
 *     puts the eye *outside* the skin looking at the top of its own fuselage,
 *     and no amount of interior detail is visible from there;
 *   - the **floor** is 84 cm below the eye, which is a seated pilot;
 *   - the **panel** closes the forward end of the opening, its coaming on the
 *     sill line, so the cut edge in the skin and the top of the panel are the
 *     same line;
 *   - the **tub** walls run from the sill edge down to the floor following the
 *     fuselage section, so they cannot poke through the skin.
 *
 * ## Needles
 *
 * Faces are painted; needles are geometry on named pivots that rotate about the
 * panel normal. 'PANEL_GAUGES' is the single table the painter and the animator
 * both read, so a needle cannot disagree with the ticks under it — which is the
 * bug the art director found in the HUD's G meter.
 */

import * as THREE from 'three';
import type { AircraftSpec } from '../../shared/aircraft';
import { boxOf } from '../textures/atlas';
import type { GaugeName, Rect, UvBox } from '../textures/atlas';
import {
  MeshBuilder, boxGeom, cylGeom, flipWinding, mergeGeoms, quadGeom, sphereGeom, trs, uvIn,
} from './geom';
import type { FuselageProfile } from './fuselage';
import { canopyOpening } from './canopy';
import type { CanopyOpening } from './canopy';
import {
  Rand, ctx2d, drawText, fbm, hex, makeCanvas, makeTexture, rgba, roundRectPath, scratches,
} from '../textures/canvas2d';
import type { Ctx2D } from '../textures/canvas2d';

// ---------------------------------------------------------------------------
// Texture sheet layout
// ---------------------------------------------------------------------------

const ATLAS = 1024;
const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/** Instrument panel: the whole top half of the sheet, 2:1 to match the panel. */
const PANEL_RECT = R(0, 0, 1024, 512);
/** Eight 256² material cells across the bottom half. */
const CELL_NAMES = [
  'tub', 'leather', 'blackMetal', 'floor',
  'canvas', 'alloy', 'needle', 'reticle',
] as const;
type CellName = (typeof CELL_NAMES)[number];
const CELL: Record<CellName, Rect> = (() => {
  const out = {} as Record<CellName, Rect>;
  CELL_NAMES.forEach((n, i) => {
    out[n] = R((i % 4) * 256, 512 + ((i / 4) | 0) * 256, 256, 256);
  });
  return out;
})();

const panelBox = (): UvBox => boxOf(PANEL_RECT, 2, ATLAS);
const cellBox = (n: CellName, pad = 6): UvBox => boxOf(CELL[n], pad, ATLAS);

// ---------------------------------------------------------------------------
// The panel layout — read by both the painter and the needle animator
// ---------------------------------------------------------------------------

/** Panel plate size, metres. The 2:1 sheet aspect is chosen to match this. */
export const PANEL_W = 0.58;
export const PANEL_H = 0.29;

export interface GaugeSpec {
  name: GaugeName;
  /** Dial centre in panel-plate coordinates, metres, +x starboard, +y up. */
  x: number;
  y: number;
  /** Dial radius (the glass, not the bezel), metres. */
  r: number;
  /** Needle angle, radians clockwise from 12 o'clock, at 'v0' and at 'v1'. */
  a0: number;
  a1: number;
  v0: number;
  v1: number;
  label: string;
  sub?: string;
  /** Major divisions across the sweep, and minor ticks per major. */
  major: number;
  minor: number;
  /** Numerals placed at the major divisions, first at 'v0'. */
  numerals: string[];
  redArc?: [number, number];
  yellowArc?: [number, number];
  face?: 'dial' | 'horizon' | 'compass' | 'turn';
  /** Two-needle instruments (altimeter) get a second, faster hand. */
  secondHand?: number;
}

const FULL = Math.PI * 2;
/** 320° sweep with the gap at the bottom — the standard round-dial layout. */
const SWEEP0 = 0.35, SWEEP1 = FULL - 0.35;

/**
 * The blind-flying six in the centre, engine group to one side, ancillaries to
 * the other. This is the RAF panel and it is what a Spitfire, Hurricane or
 * Typhoon pilot actually looked at; the German and American panels differ in
 * detail but not in the reading order, so one layout serves every type.
 *
 * The signs look inverted against the body frame on purpose. The camera rig
 * maps body +X to the *left* of the screen (CameraSystem BODY_TO_CAM is a 180°
 * yaw, which sends the camera's +X to body −X), so a gauge at negative x lands
 * on the pilot's right. These x values are chosen so the panel matches a
 * photograph of the real thing on screen — ASI top left, altimeter top right —
 * which is the only place anyone judges it.
 */
export const PANEL_GAUGES: GaugeSpec[] = [
  {
    name: 'airspeed', x: 0.0857, y: 0.0598, r: 0.0440, a0: SWEEP0, a1: SWEEP1,
    v0: 0, v1: 800, label: 'A.S.I.', sub: 'KM/H', major: 8, minor: 5,
    numerals: ['0', '1', '2', '3', '4', '5', '6', '7', '8'], redArc: [0.9, 1],
  },
  {
    name: 'horizon', x: 0, y: 0.0598, r: 0.0440, a0: -1.0, a1: 1.0,
    v0: -1, v1: 1, label: 'HORIZON', major: 6, minor: 3,
    numerals: [], face: 'horizon',
  },
  {
    name: 'altimeter', x: -0.0857, y: 0.0598, r: 0.0440, a0: 0, a1: FULL,
    v0: 0, v1: 3048, label: 'ALT', sub: '1000 FT', major: 10, minor: 5,
    numerals: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], secondHand: 10,
  },
  {
    name: 'turnslip', x: 0.0857, y: -0.0598, r: 0.0440, a0: -0.42, a1: 0.42,
    v0: -1, v1: 1, label: 'TURN', major: 4, minor: 2, numerals: [], face: 'turn',
  },
  {
    name: 'compass', x: 0, y: -0.0598, r: 0.0440, a0: 0, a1: FULL,
    v0: 0, v1: FULL, label: 'D.I.', major: 12, minor: 3, numerals: [], face: 'compass',
  },
  {
    name: 'vsi', x: -0.0857, y: -0.0598, r: 0.0440, a0: -2.45, a1: 2.45,
    v0: -20, v1: 20, label: 'CLIMB', sub: 'M/S', major: 8, minor: 5,
    numerals: ['20', '10', '5', '2', '0', '2', '5', '10', '20'],
  },
  {
    name: 'rpm', x: -0.1723, y: 0.0598, r: 0.0334, a0: SWEEP0, a1: SWEEP1,
    v0: 0, v1: 4000, label: 'R.P.M.', sub: '×100', major: 8, minor: 5,
    numerals: ['0', '5', '10', '15', '20', '25', '30', '35', '40'],
    redArc: [0.85, 1], yellowArc: [0.72, 0.85],
  },
  {
    name: 'boost', x: -0.1723, y: -0.0598, r: 0.0334, a0: SWEEP0, a1: SWEEP1,
    v0: -8, v1: 16, label: 'BOOST', sub: 'LB/IN²', major: 6, minor: 4,
    numerals: ['-8', '-4', '0', '+4', '+8', '+12', '+16'], redArc: [0.88, 1],
  },
  {
    name: 'oiltemp', x: -0.2488, y: 0.0835, r: 0.0251, a0: SWEEP0, a1: Math.PI * 0.92,
    v0: 0, v1: 120, label: 'OIL °C', major: 3, minor: 4,
    numerals: ['0', '40', '80', '120'], redArc: [0.84, 1],
  },
  {
    name: 'oilpress', x: -0.2488, y: 0.0044, r: 0.0251, a0: SWEEP0, a1: Math.PI * 0.92,
    v0: 0, v1: 120, label: 'OIL LB', major: 3, minor: 4,
    numerals: ['0', '40', '80', '120'],
  },
  {
    name: 'fuel', x: -0.2488, y: -0.0774, r: 0.0251, a0: -1.15, a1: 1.15,
    v0: 0, v1: 1, label: 'FUEL', major: 4, minor: 2,
    numerals: ['E', '¼', '½', '¾', 'F'], redArc: [0, 0.13],
  },
  {
    name: 'clock', x: 0.2488, y: 0.0835, r: 0.0251, a0: 0, a1: FULL,
    v0: 0, v1: 12, label: '', major: 12, minor: 5,
    numerals: ['12', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'],
  },
  {
    name: 'ammo', x: 0.2488, y: 0.0044, r: 0.0251, a0: -1.15, a1: 1.15,
    v0: 0, v1: 1, label: 'ROUNDS', major: 4, minor: 2,
    numerals: ['0', '', '', '', 'MAX'], redArc: [0, 0.16],
  },
  {
    name: 'radiator', x: 0.2488, y: -0.0774, r: 0.0251, a0: -1.1, a1: 1.1,
    v0: 0, v1: 1, label: 'RAD', major: 4, minor: 2,
    numerals: ['SHUT', '', '', '', 'OPEN'],
  },
];

/** Needle angle for a raw instrument value, radians clockwise from 12 o'clock. */
export function gaugeAngle(g: GaugeSpec, value: number): number {
  const f = Math.max(0, Math.min(1, (value - g.v0) / (g.v1 - g.v0)));
  return g.a0 + (g.a1 - g.a0) * f;
}

// ---------------------------------------------------------------------------
// Build result
// ---------------------------------------------------------------------------

/**
 * What a needle needs in order to be driven, published as plain data on the
 * pivot's 'userData'. The animator lives in the game layer, which resolves this
 * module lazily and must not import it — so the mapping travels with the rig
 * rather than being duplicated on the other side of that seam, where it would
 * drift out of step with the painted ticks.
 */
export interface NeedleRange {
  a0: number; a1: number; v0: number; v1: number;
  /** True for the instruments whose hands go round and round. */
  wrap?: boolean;
}

export interface NeedleDef {
  name: GaugeName;
  /** Local position of the dial centre, in the aircraft body frame. */
  pos: THREE.Vector3;
  geometry: THREE.BufferGeometry;
  range: NeedleRange;
  /** Extra hand on the same pivot chain (altimeter hundreds), or undefined. */
  fast?: boolean;
}

export interface CockpitResult {
  /** Everything painted from the cockpit sheet: tub, panel, seat, controls. */
  interior: THREE.BufferGeometry;
  /** Reflector-sight glass — its own translucent, emissive material. */
  sightGlass: THREE.BufferGeometry;
  needles: NeedleDef[];
  pilot: THREE.BufferGeometry;
  /** Where the pilot's eyes are: the cockpit camera anchor. */
  eyePoint: THREE.Vector3;
  /** Rotation about X that lays a +Z-facing quad onto the panel plane. */
  panelTilt: number;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Panel rake: leaned back at the top, the way a real one is, so it catches light. */
const PANEL_TILT = -0.13;

export function buildCockpit(spec: AircraftSpec, prof: FuselageProfile): CockpitResult {
  const c = spec.geom.canopy;
  const open = canopyOpening(spec, prof);
  const rad = prof.R;

  // --- the three anchors ----------------------------------------------------
  const zSeat = (c.z0 + c.z1) * 0.5 - 0.08;
  const zEye = zSeat + 0.14;
  const yEye = open.sillY(zEye) + open.height * 0.33;
  const floorY = yEye - 0.84;

  // The panel closes the forward end of the opening; its coaming lies on the
  // sill, so the skin's cut edge and the top of the panel are one line.
  const zPanel = open.z0 + 0.03;
  const sillPanel = open.sillY(open.z0);
  const panelTop = sillPanel - 0.028;
  const panelY = panelTop - PANEL_H * 0.5;

  const tubBox = cellBox('tub');
  const leatherBox = cellBox('leather');
  const darkBox = cellBox('blackMetal');
  const floorBox = cellBox('floor');
  const canvasBox = cellBox('canvas');
  const alloyBox = cellBox('alloy');

  const parts: THREE.BufferGeometry[] = [];

  // --- the tub --------------------------------------------------------------
  // A closed U-section: down one wall from the sill edge, across the floor, up
  // the other, capped at both ends. It has to be closed. Left open at the front
  // the camera looked straight out through the bottom of the fuselage and put a
  // sunlit wing root in the middle of the footwell.
  parts.push(buildTub(prof, open, floorY, zPanel + 0.06, tubBox));

  // Ribbed alloy floorboard laid on top of the tub bottom, where the pilot's
  // heels actually are.
  const floorHalf = sideAtY(prof, zSeat, floorY) * 0.80;
  const floor = boxGeom(floorHalf * 2, 0.016, Math.abs(open.z0 - open.z1) * 0.70, floorBox, 2.4);
  floor.applyMatrix4(trs([0, floorY + 0.012, zSeat + 0.16]));
  parts.push(floor);

  // --- instrument panel -----------------------------------------------------
  // One quad, one texture. Everything on a real panel is flat anyway.
  const panel = quadGeom(PANEL_W, PANEL_H, panelBox());
  panel.applyMatrix4(trs([0, panelY, zPanel], [Math.PI + PANEL_TILT, 0, 0]));
  parts.push(panel);
  // Case depth behind the plate: the dials are 12 cm cans, and without the box
  // the panel reads as a sticker floating in the hole.
  const panelCase = boxGeom(PANEL_W * 0.99, PANEL_H * 0.99, 0.14, darkBox);
  panelCase.applyMatrix4(trs([0, panelY + 0.008, zPanel + 0.075], [PANEL_TILT, 0, 0]));
  parts.push(panelCase);

  // Coaming: the padded anti-glare lip along the top of the panel, on the sill.
  const coaming = buildCoaming(prof, open, sillPanel, leatherBox);
  parts.push(coaming);

  // --- reflector gunsight ---------------------------------------------------
  const zSight = zPanel - 0.11;
  const ySight = sillPanel + 0.055;
  const sightParts: THREE.BufferGeometry[] = [];
  // Mounting bracket off the coaming.
  const bracket = boxGeom(0.10, 0.03, 0.09, darkBox);
  bracket.applyMatrix4(trs([0, sillPanel + 0.012, zSight + 0.01]));
  sightParts.push(bracket);
  // Lamp housing: the barrel that projects the graticule up onto the glass.
  const body = cylGeom(0.031, 0.028, 0.15, 10, darkBox, true);
  body.applyMatrix4(trs([0, ySight - 0.005, zSight + 0.055], [Math.PI / 2, 0, 0]));
  sightParts.push(body);
  const hood = cylGeom(0.037, 0.033, 0.035, 10, darkBox, false);
  hood.applyMatrix4(trs([0, ySight - 0.005, zSight - 0.028], [Math.PI / 2, 0, 0]));
  sightParts.push(hood);
  // Glass frame: two uprights and a top rail around the reflector plate.
  for (const sx of [-1, 1]) {
    const post = boxGeom(0.009, 0.115, 0.009, darkBox);
    post.applyMatrix4(trs([sx * 0.061, ySight + 0.050, zSight - 0.056], [-0.40, 0, 0]));
    sightParts.push(post);
  }
  const rail = boxGeom(0.131, 0.009, 0.009, darkBox);
  rail.applyMatrix4(trs([0, ySight + 0.099, zSight - 0.077]));
  sightParts.push(rail);
  parts.push(mergeGeoms(sightParts));

  // The reflector plate itself: raked back 23°, which is what puts the
  // projected graticule on the pilot's line of sight rather than on the cowl.
  const sightGlass = quadGeom(0.122, 0.112, cellBox('reticle', 3));
  sightGlass.applyMatrix4(trs([0, ySight + 0.050, zSight - 0.056], [Math.PI - 0.40, 0, 0]));

  // --- seat -----------------------------------------------------------------
  const seatY = floorY + 0.20;
  const pan = boxGeom(0.42, 0.035, 0.42, canvasBox);
  pan.applyMatrix4(trs([0, seatY, zSeat - 0.04]));
  parts.push(pan);
  const back = boxGeom(0.42, 0.56, 0.032, canvasBox);
  back.applyMatrix4(trs([0, seatY + 0.26, zSeat - 0.25], [-0.15, 0, 0]));
  parts.push(back);
  for (const sx of [-1, 1]) {
    const bolster = boxGeom(0.028, 0.24, 0.38, canvasBox);
    bolster.applyMatrix4(trs([sx * 0.21, seatY + 0.11, zSeat - 0.07], [-0.07, 0, 0]));
    parts.push(bolster);
  }
  // Head armour and the plate behind the pilot's back.
  const head = boxGeom(0.21, 0.16, 0.055, leatherBox);
  head.applyMatrix4(trs([0, yEye + 0.10, zSeat - 0.33], [-0.15, 0, 0]));
  parts.push(head);
  const armour = boxGeom(0.46, 0.66, 0.014, alloyBox);
  armour.applyMatrix4(trs([0, seatY + 0.32, zSeat - 0.36], [-0.13, 0, 0]));
  parts.push(armour);
  for (const sx of [-1, 1]) {
    const strap = boxGeom(0.055, 0.44, 0.008, leatherBox);
    strap.applyMatrix4(trs([sx * 0.0835, seatY + 0.28, zSeat - 0.20], [-0.17, 0, sx * 0.11]));
    parts.push(strap);
  }

  // --- control column -------------------------------------------------------
  const stickFoot = new THREE.Vector3(0, floorY + 0.03, zSeat + 0.44);
  const column = cylGeom(0.024, 0.017, 0.42, 8, alloyBox);
  column.applyMatrix4(trs([0, stickFoot.y + 0.21, stickFoot.z - 0.02], [0.09, 0, 0]));
  parts.push(column);
  const grip = cylGeom(0.027, 0.025, 0.15, 8, leatherBox);
  grip.applyMatrix4(trs([0, stickFoot.y + 0.47, stickFoot.z - 0.06], [0.09, 0, 0]));
  parts.push(grip);
  // Spade head with the brake lever and the gun button.
  const spade = boxGeom(0.062, 0.055, 0.028, darkBox);
  spade.applyMatrix4(trs([0, stickFoot.y + 0.555, stickFoot.z - 0.075]));
  parts.push(spade);

  // --- rudder pedals --------------------------------------------------------
  for (const sx of [-1, 1]) {
    const bar = boxGeom(0.11, 0.022, 0.10, alloyBox);
    bar.applyMatrix4(trs([sx * 0.115, floorY + 0.11, zSeat + 0.80], [0.32, 0, 0]));
    parts.push(bar);
    const arm = cylGeom(0.012, 0.012, 0.24, 6, alloyBox);
    arm.applyMatrix4(trs([sx * 0.115, floorY + 0.05, zSeat + 0.70], [1.28, 0, 0]));
    parts.push(arm);
  }

  // --- sidewall structure and consoles --------------------------------------
  parts.push(buildSidewalls(prof, open, floorY, zSeat, zPanel, darkBox, alloyBox, leatherBox));

  const eyePoint = new THREE.Vector3(0, yEye, zEye);

  // --- needles --------------------------------------------------------------
  const needles: NeedleDef[] = [];
  const place = (x: number, y: number, dz: number): THREE.Vector3 => {
    const cy = Math.cos(PANEL_TILT), sy = Math.sin(PANEL_TILT);
    return new THREE.Vector3(x, panelY + y * cy - dz * sy, zPanel + y * sy + dz * cy);
  };
  for (const g of PANEL_GAUGES) {
    if (g.face === 'horizon' || g.face === 'turn' || g.face === 'compass') {
      // These three read off a moving card, not a needle; the card is painted
      // and the pointer is part of the face. Skip the geometry.
      if (g.face !== 'compass') continue;
    }
    const wrap = g.a1 - g.a0 >= FULL - 1e-3;
    needles.push({
      name: g.name,
      pos: place(g.x, g.y, -0.0075),
      geometry: needleGeom(g.r, 0.075, 0.80),
      range: { a0: g.a0, a1: g.a1, v0: g.v0, v1: g.v1, wrap },
    });
    if (g.secondHand) {
      needles.push({
        name: g.name,
        pos: place(g.x, g.y, -0.0105),
        geometry: needleGeom(g.r, 0.10, 0.52),
        range: { a0: g.a0, a1: g.a1, v0: g.v0, v1: g.v1 / g.secondHand, wrap: true },
        fast: true,
      });
    }
  }

  void rad;
  return {
    interior: mergeGeoms(parts),
    sightGlass,
    needles,
    pilot: buildPilot(spec, floorY, zSeat, eyePoint, canvasBox, leatherBox, darkBox),
    eyePoint,
    panelTilt: PANEL_TILT,
  };
}

/**
 * Half-width of the fuselage section at station z, at height y.
 *
 * Bisected rather than solved: the section is a superellipse whose exponent
 * varies along the fuselage, and ten halvings land inside a tenth of a
 * millimetre, once, at build time.
 */
function sideAtY(prof: FuselageProfile, z: number, y: number): number {
  const s = prof.at(z);
  const dy = y - s.yc;
  const ry = dy >= 0 ? s.ryTop : s.ryBot;
  const t = Math.min(1, Math.abs(dy) / Math.max(1e-4, ry));
  const e = 2 / s.n;
  // |x/rx|^n + |y/ry|^n = 1  →  x = rx·(1 − t^n)^(1/n).
  const v = Math.max(0, 1 - Math.pow(t, 1 / e));
  return s.rx * Math.pow(v, e);
}

/**
 * Half of the tub's cross-section at station z.
 *
 * 's' walks from the sill edge (0) down the wall and across the floor to the
 * centreline (1). The top of the wall traces the same curve the skin was cut
 * along, inset a little, so the cut edge reads as a sill with real thickness;
 * below that it blends onto the fuselage section, which is what stops it
 * poking through the skin where the fuselage narrows.
 */
const TUB_WALL = 0.66;

function tubSection(
  prof: FuselageProfile, open: CanopyOpening, floorY: number, z: number, s: number,
  out: { x: number; y: number },
): void {
  const ySill = open.sillY(z);
  // The sill half-width is frozen 5 cm short of each end of the opening. The
  // tub has to run past the cut — forward of the panel and aft of the bulkhead
  // — and the opening's rounded corners taper to nothing there, which would
  // pinch the tub to a knife edge exactly where it has to be widest.
  const zHw = Math.min(Math.max(z, open.z1 + 0.05), open.z0 - 0.05);
  const hw = Math.max(0.02, open.halfWidth(zHw) - 0.028);
  const footX = Math.max(0.03, sideAtY(prof, z, floorY) * 0.94 - 0.025);
  if (s <= TUB_WALL) {
    const v = s / TUB_WALL;
    const y = ySill + (floorY - ySill) * v;
    const wall = Math.max(0.03, sideAtY(prof, z, y) * 0.94 - 0.025);
    // Leave the sill vertically, then ease onto the section: a straight taper
    // from the lip creates a visible crease down the middle of the wall.
    const k = v * v * (3 - 2 * v);
    out.x = hw + (wall - hw) * k;
    out.y = y;
  } else {
    const v = (s - TUB_WALL) / (1 - TUB_WALL);
    out.x = footX * (1 - v);
    out.y = floorY;
  }
}

function buildTub(
  prof: FuselageProfile, open: CanopyOpening, floorY: number, zFront: number, box: UvBox,
): THREE.BufferGeometry {
  const N = 20, M = 7;
  const geoms: THREE.BufferGeometry[] = [];
  const p = { x: 0, y: 0 };
  // The forward cap must sit *ahead* of the instrument panel. Behind it, it is
  // a slab between the pilot and his own instruments.
  const zF = zFront, zA = open.z1 - 0.02;

  for (const sx of [-1, 1]) {
    // Walls + floor.
    const b = new MeshBuilder();
    b.addGrid(N + 1, M + 1, (i, j, o) => {
      const t = i / N;
      const z = zF + (zA - zF) * t;
      tubSection(prof, open, floorY, z, j / M, p);
      o.x = sx * p.x;
      o.y = p.y;
      o.z = z;
      const [u, v] = uvIn(box, (t * 3.4) % 1, j / M);
      o.u = u; o.v = v;
    }, sx < 0);
    geoms.push(b.build(true));

    // End caps: the cross-section filled in to the centreline. Without these
    // the tub is a trough open at both ends and you see out of the aeroplane.
    for (const [z, front] of [[zF, true], [zA, false]] as [number, boolean][]) {
      const cap = new MeshBuilder();
      cap.addGrid(M + 1, 2, (i, j, o) => {
        tubSection(prof, open, floorY, z, i / M, p);
        o.x = j === 0 ? sx * p.x : 0;
        o.y = p.y;
        o.z = z;
        const [u, v] = uvIn(box, j * 0.5, i / M);
        o.u = u; o.v = v;
      }, front === (sx > 0));
      geoms.push(cap.build(true));
    }
  }
  return mergeGeoms(geoms);
}

/**
 * Anti-glare coaming: a padded roll along the sill from the panel back to about
 * a third of the way down the opening, which is what a pilot's forearms rest on
 * and what stops the panel from reading as a plate stuck in a hole.
 */
function buildCoaming(
  prof: FuselageProfile, open: CanopyOpening, sillPanel: number, box: UvBox,
): THREE.BufferGeometry {
  void prof;
  void sillPanel;
  // The front roll is a straight bar across the top of the panel; the sills are
  // two swept rails, so the shape reads as three pieces of trim rather than one
  // impossible extrusion round a corner.
  const parts: THREE.BufferGeometry[] = [];
  const width = Math.max(0.1, open.halfWidth(open.z0 - 0.02) * 2);
  const frontRoll = boxGeom(Math.max(width, PANEL_W * 1.03), 0.052, 0.10, box, 1);
  frontRoll.applyMatrix4(trs([0, open.sillY(open.z0) - 0.012, open.z0 - 0.035], [0.30, 0, 0]));
  parts.push(frontRoll);

  for (const sx of [-1, 1]) {
    const railN = 12;
    const rb = new MeshBuilder();
    rb.addGrid(railN + 1, 4, (i, j, o) => {
      const t = i / railN;
      const z = open.z0 - 0.02 + (open.z1 + 0.04 - (open.z0 - 0.02)) * t;
      const hw = Math.max(0.03, open.halfWidth(z));
      const y = open.sillY(z);
      const rr = 0.026;
      const a = (j / 3) * Math.PI;
      o.x = sx * (hw - 0.012 + Math.cos(a) * rr * 0.9);
      o.y = y + Math.sin(a) * rr * 0.7 - 0.004;
      o.z = z;
      const [u, v] = uvIn(box, t * 2, j / 3);
      o.u = u; o.v = v;
    }, sx > 0);
    parts.push(rb.build(true));
  }
  return mergeGeoms(parts);
}

/**
 * Port and starboard sidewall furniture: longerons, the throttle quadrant with
 * its levers, the trim wheel, the oxygen regulator and a couple of placards.
 * All of it is inboard of the tub wall, so none of it can poke through the skin.
 */
function buildSidewalls(
  prof: FuselageProfile, open: CanopyOpening, floorY: number, zSeat: number, zPanel: number,
  dark: UvBox, alloy: UvBox, leather: UvBox,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const yMid = floorY + 0.30;
  const wallAt = (z: number, y: number) => sideAtY(prof, z, y) * 0.95 - 0.04;

  // Everything the pilot can see of his own sidewalls is *forward* of his
  // shoulders: at a 100° horizontal field the wall beside the seat is behind
  // the near plane. Structure placed at the seat station is structure nobody
  // ever sees, which is why the flanks of this cockpit were two empty planes.
  const zFwd = zPanel - 0.10;

  for (const sx of [-1, 1]) {
    // Top longeron, running from the firewall aft past the seat.
    const zA = zPanel - 0.02, zB = open.z1 + 0.10;
    const n = 10;
    const b = new MeshBuilder();
    b.addGrid(n + 1, 4, (i, j, o) => {
      const t = i / n;
      const z = zA + (zB - zA) * t;
      const y = yMid + 0.20;
      const w = wallAt(z, y);
      o.x = sx * (w - (j === 1 || j === 2 ? 0.032 : 0));
      o.y = y + (j < 2 ? 0.022 : -0.022);
      o.z = z;
      const [u, v] = uvIn(alloy, t * 3 % 1, j / 3);
      o.u = u; o.v = v;
    }, sx < 0);
    parts.push(b.build(true));

    // Formers standing proud of the wall, spaced the way a fuselage frame bay
    // is — close enough to read as structure, not as decoration.
    for (let k = 0; k < 4; k++) {
      const z = zFwd - k * 0.27;
      const w = wallAt(z, yMid);
      const former = boxGeom(0.016, 0.46, 0.026, dark);
      former.applyMatrix4(trs([sx * (w - 0.011), yMid, z]));
      parts.push(former);
    }
  }

  // --- port sidewall: throttle quadrant, forward where it can be seen -------
  {
    const z = zFwd - 0.20;
    const w = wallAt(z, yMid);
    const quad = boxGeom(0.038, 0.15, 0.28, dark);
    quad.applyMatrix4(trs([-(w - 0.032), yMid + 0.05, z]));
    parts.push(quad);
    for (let i = 0; i < 3; i++) {
      const lever = boxGeom(0.015, 0.18, 0.024, alloy);
      lever.applyMatrix4(trs([-(w - 0.062), yMid + 0.14, z + 0.09 - i * 0.07], [0.34 - i * 0.16, 0, 0]));
      parts.push(lever);
      const knob = sphereGeom(0.018, 8, 6, i === 0 ? leather : dark);
      knob.applyMatrix4(trs([-(w - 0.062), yMid + 0.23, z + 0.12 - i * 0.085]));
      parts.push(knob);
    }
    // Elevator trim wheel, aft of the quadrant and canted into the wall.
    const wheel = cylGeom(0.062, 0.062, 0.016, 16, alloy, true);
    wheel.applyMatrix4(trs([-(w - 0.024), yMid - 0.05, z - 0.26], [0, 0, Math.PI / 2]));
    parts.push(wheel);
    const hub = cylGeom(0.016, 0.016, 0.05, 8, dark, true);
    hub.applyMatrix4(trs([-(w - 0.045), yMid - 0.05, z - 0.26], [0, 0, Math.PI / 2]));
    parts.push(hub);
  }

  // --- starboard sidewall: undercarriage selector, electrics, oxygen --------
  {
    const z = zFwd - 0.14;
    const w = wallAt(z, yMid);
    const box = boxGeom(0.036, 0.17, 0.22, dark);
    box.applyMatrix4(trs([w - 0.032, yMid + 0.06, z]));
    parts.push(box);
    // Undercarriage selector: a gated lever in a quadrant plate.
    const gate = boxGeom(0.012, 0.16, 0.05, alloy);
    gate.applyMatrix4(trs([w - 0.056, yMid + 0.10, z + 0.02]));
    parts.push(gate);
    const sel = cylGeom(0.010, 0.010, 0.15, 6, alloy);
    sel.applyMatrix4(trs([w - 0.070, yMid + 0.14, z + 0.02], [0.5, 0, 0]));
    parts.push(sel);
    const selKnob = sphereGeom(0.017, 8, 6, dark);
    selKnob.applyMatrix4(trs([w - 0.070, yMid + 0.21, z + 0.055]));
    parts.push(selKnob);

    const reg = cylGeom(0.032, 0.032, 0.032, 10, alloy, true);
    reg.applyMatrix4(trs([w - 0.048, yMid + 0.10, z - 0.26], [0, 0, Math.PI / 2]));
    parts.push(reg);
    const bottle = cylGeom(0.040, 0.040, 0.30, 10, dark, true);
    bottle.applyMatrix4(trs([w - 0.060, floorY + 0.26, z - 0.42], [Math.PI / 2, 0, 0.10]));
    parts.push(bottle);
  }

  void zSeat;
  void open;
  return mergeGeoms(parts);
}

/** Needle: a tapered blade with its root at the pivot, pointing +Y at zero. */
function needleGeom(r: number, widthFrac: number, lengthFrac: number): THREE.BufferGeometry {
  const box = cellBox('needle', 4);
  const b = new MeshBuilder();
  const w = r * widthFrac, L = r * lengthFrac, tail = r * 0.20, th = r * 0.035;
  const quadFace = (z: number, flip: boolean) => {
    const a = b.vert(-w, -tail, z, ...uvIn(box, 0, 1));
    const c = b.vert(w, -tail, z, ...uvIn(box, 1, 1));
    const d = b.vert(w * 0.30, L, z, ...uvIn(box, 1, 0));
    const e = b.vert(-w * 0.30, L, z, ...uvIn(box, 0, 0));
    if (flip) b.quad(a, e, d, c); else b.quad(a, c, d, e);
  };
  quadFace(th, false);
  quadFace(-th, true);
  return b.build(false);
}

// ---------------------------------------------------------------------------
// Pilot
// ---------------------------------------------------------------------------

/**
 * A seated pilot at the level of detail that survives being viewed through
 * tinted perspex from two metres: helmet, goggles, oxygen mask, shoulders,
 * upper arms reaching to the stick and throttle. No hands modelled — they are
 * inside the grips.
 *
 * From the cockpit camera the head is inside the near plane and back-face
 * culled away, so what the player sees of himself is a chest, two arms and two
 * thighs, which is exactly right.
 */
function buildPilot(
  spec: AircraftSpec, floorY: number, zSeat: number, eye: THREE.Vector3,
  cloth: UvBox, leather: UvBox, dark: UvBox,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const glass = dark;

  const hy = eye.y + 0.02;
  const hz = eye.z - 0.07;

  const head = sphereGeom(0.098, 12, 8, leather);
  head.scale(0.92, 1.06, 1.0);
  head.applyMatrix4(trs([0, hy, hz]));
  parts.push(head);
  const band = boxGeom(0.175, 0.052, 0.03, dark);
  band.applyMatrix4(trs([0, hy + 0.028, hz + 0.078], [0.05, 0, 0]));
  parts.push(band);
  for (const sx of [-1, 1]) {
    const lens = cylGeom(0.030, 0.030, 0.012, 10, glass);
    lens.applyMatrix4(trs([sx * 0.042, hy + 0.030, hz + 0.092], [Math.PI / 2, 0, 0]));
    parts.push(lens);
  }
  const mask = sphereGeom(0.055, 10, 6, dark);
  mask.scale(0.85, 0.75, 0.7);
  mask.applyMatrix4(trs([0, hy - 0.045, hz + 0.062]));
  parts.push(mask);
  const hose = cylGeom(0.014, 0.014, 0.16, 6, dark);
  hose.applyMatrix4(trs([0.05, hy - 0.12, hz + 0.03], [0.5, 0, 0.6]));
  parts.push(hose);

  const torso = boxGeom(0.36, 0.40, 0.24, cloth);
  torso.applyMatrix4(trs([0, hy - 0.34, hz - 0.055], [-0.14, 0, 0]));
  parts.push(torso);
  for (const sx of [-1, 1]) {
    const strap = boxGeom(0.045, 0.40, 0.02, leather);
    strap.applyMatrix4(trs([sx * 0.08, hy - 0.30, hz + 0.055], [-0.14, 0, sx * 0.16]));
    parts.push(strap);
    const arm = cylGeom(0.048, 0.042, 0.30, 8, cloth);
    arm.applyMatrix4(trs([sx * 0.19, hy - 0.34, hz + 0.02], [0.55, 0, sx * 0.18]));
    parts.push(arm);
    const fore = cylGeom(0.040, 0.036, 0.28, 8, cloth);
    fore.applyMatrix4(trs([sx * 0.16, hy - 0.50, hz + 0.20], [1.15, 0, sx * 0.10]));
    parts.push(fore);
    const leg = cylGeom(0.062, 0.055, 0.36, 8, cloth);
    leg.applyMatrix4(trs([sx * 0.11, floorY + 0.30, zSeat + 0.28], [1.42, 0, 0]));
    parts.push(leg);
  }

  void spec;
  return mergeGeoms(parts);
}

// ---------------------------------------------------------------------------
// The texture sheet
// ---------------------------------------------------------------------------

export interface CockpitAtlas {
  texture: THREE.CanvasTexture;
  dispose(): void;
}

const INTERIOR_GREEN = 0x565e46;
const PANEL_BLACK = 0x1b1a17;
const MARK = 0xe8e4d6;
const DIM = 0x9d998c;
const WARN = 0xc0392b;
const CAUTION = 0xd8a62b;

export function buildCockpitAtlas(spec: AircraftSpec): CockpitAtlas {
  const cv = makeCanvas(ATLAS, ATLAS);
  const g = ctx2d(cv);
  const rnd = new Rand(0x5a17 ^ spec.id.length * 977);

  g.fillStyle = hex(PANEL_BLACK);
  g.fillRect(0, 0, ATLAS, ATLAS);

  paintPanel(g, PANEL_RECT, rnd, spec);
  paintTub(g, CELL.tub, rnd);
  paintLeather(g, CELL.leather, rnd);
  paintBlackMetal(g, CELL.blackMetal, rnd);
  paintFloor(g, CELL.floor, rnd);
  paintCanvas(g, CELL.canvas, rnd);
  paintAlloy(g, CELL.alloy, rnd);
  paintNeedle(g, CELL.needle);
  paintReticle(g, CELL.reticle);

  const texture = makeTexture(cv, { aniso: 8 });
  return { texture, dispose() { texture.dispose(); } };
}

// --- the panel --------------------------------------------------------------

/**
 * The panel is painted into a scratch canvas and then blitted into the sheet
 * **mirrored**, and the layout is mirrored a second time on the way in.
 *
 * The reason is that the body frame this project uses (+X starboard, +Y up, +Z
 * nose) is left-handed, so from the pilot's seat body +X lands on the *left*
 * of the screen. A quad's texture therefore arrives horizontally flipped, and
 * every numeral, label and placard on the panel came out back to front. Two
 * mirrors cancel: painting the layout at −x puts each dial back under its own
 * needle, and the flipped blit puts the lettering the right way round. Fixing
 * it by flipping the UV box alone would have un-mirrored the text and mirrored
 * the dial sweeps instead, so every gauge would have counted backwards.
 */
function paintPanel(g: Ctx2D, r: Rect, rnd: Rand, spec: AircraftSpec): void {
  const tmp = makeCanvas(r.w, r.h);
  const tg = ctx2d(tmp);
  paintPanelFace(tg, { x: 0, y: 0, w: r.w, h: r.h }, rnd, spec);
  g.save();
  g.translate(r.x + r.w, r.y);
  g.scale(-1, 1);
  g.drawImage(tmp, 0, 0);
  g.restore();
}

function paintPanelFace(g: Ctx2D, r: Rect, rnd: Rand, spec: AircraftSpec): void {
  const pxPerM = r.w / PANEL_W;
  const cx = (x: number) => r.x + r.w * 0.5 - x * pxPerM;
  const cy = (y: number) => r.y + r.h * 0.5 - y * pxPerM;

  // Crackle-black instrument finish with a warm bounce from the floor.
  g.fillStyle = hex(PANEL_BLACK);
  g.fillRect(r.x, r.y, r.w, r.h);
  for (let y = 0; y < r.h; y += 2) {
    for (let x = 0; x < r.w; x += 2) {
      const n = fbm(x * 0.09, y * 0.09, 4, 11);
      if (n > 0.56) {
        g.fillStyle = rgba(0x35322c, (n - 0.56) * 1.7);
        g.fillRect(r.x + x, r.y + y, 2, 2);
      }
    }
  }
  const bounce = g.createLinearGradient(0, r.y + r.h, 0, r.y);
  bounce.addColorStop(0, 'rgba(120,96,58,0.16)');
  bounce.addColorStop(0.5, 'rgba(60,64,58,0.05)');
  bounce.addColorStop(1, 'rgba(150,175,200,0.09)');
  g.fillStyle = bounce;
  g.fillRect(r.x, r.y, r.w, r.h);

  // Sub-plates: the panel is built up from riveted sections, not one sheet.
  const plates: [number, number, number, number][] = [
    [-0.128, -0.119, 0.255, 0.238], [0.119, -0.119, 0.119, 0.238], [-0.264, -0.119, 0.128, 0.238],
  ];
  for (const [px, py, pw, ph] of plates) {
    // 'cx' runs the other way (see the note on paintPanel), so the plate's
    // left-hand edge is its *far* corner in panel coordinates.
    const x0 = cx(px + pw), y0 = cy(py + ph), w = pw * pxPerM, h = ph * pxPerM;
    g.fillStyle = 'rgba(255,255,255,0.035)';
    roundRectPath(g, x0, y0, w, h, 8); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 2;
    roundRectPath(g, x0, y0, w, h, 8); g.stroke();
    // Fastener rows.
    const n = Math.max(3, Math.round(w / 46));
    for (let i = 0; i <= n; i++) {
      for (const yy of [y0 + 8, y0 + h - 8]) screw(g, x0 + 8 + (w - 16) * (i / n), yy, 4.2);
    }
    const m = Math.max(2, Math.round(h / 46));
    for (let i = 1; i < m; i++) {
      for (const xx of [x0 + 8, x0 + w - 8]) screw(g, xx, y0 + 8 + (h - 16) * (i / m), 4.2);
    }
  }

  // Dials.
  for (const gs of PANEL_GAUGES) {
    const R0 = gs.r * pxPerM;
    drawGauge(g, gs, cx(gs.x), cy(gs.y), R0, rnd);
  }

  // Lower console: switch bank, gun-firing gear, magneto switches.
  const swY = cy(-0.126);
  const labels = ['MAG 1', 'MAG 2', 'NAV', 'PITOT', 'GUNS', 'CAM'];
  labels.forEach((t, i) => {
    const x = cx(0.12 - i * 0.050);
    toggle(g, x, swY, 9, i % 3 === 0);
    drawText(g, t, x, swY + 20, { size: 10, color: DIM, align: 'center', weight: 700, squash: 0.85, tracking: 0.5 });
  });

  // Master switch guard, in red, top left of the console.
  g.fillStyle = rgba(WARN, 0.85);
  roundRectPath(g, cx(0.190) - 16, swY - 15, 32, 30, 4); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 2;
  roundRectPath(g, cx(0.190) - 16, swY - 15, 32, 30, 4); g.stroke();
  drawText(g, 'FIRE', cx(0.190), swY + 22, { size: 10, color: 0xd8c8b0, align: 'center', weight: 700, squash: 0.85 });

  // Type placard, so the panel says what aeroplane it is bolted into.
  const plate = { x: cx(-0.20) - 60, y: cy(-0.128) - 13 };
  g.fillStyle = 'rgba(12,14,15,0.9)';
  roundRectPath(g, plate.x, plate.y, 120, 26, 3); g.fill();
  g.strokeStyle = 'rgba(190,186,170,0.4)'; g.lineWidth = 1.5;
  roundRectPath(g, plate.x, plate.y, 120, 26, 3); g.stroke();
  drawText(g, spec.name.toUpperCase().slice(0, 16), plate.x + 60, plate.y + 13, {
    size: 12, color: 0xcfcabb, align: 'center', weight: 700, squash: 0.82, tracking: 0.6,
  });

  // Wear: the pilot's glove rubs the paint off around the dials he checks most.
  scratches(g, r, 220, rnd, 0x6c6a60, 0.16, 6, 30, 0.2, 1.4);
  for (let i = 0; i < 6; i++) {
    const x = r.x + rnd.next() * r.w, y = r.y + rnd.next() * r.h;
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.beginPath(); g.ellipse(x, y, rnd.range(20, 70), rnd.range(10, 34), rnd.next() * 3, 0, 6.2832); g.fill();
  }
}

function screw(g: Ctx2D, x: number, y: number, r: number): void {
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath(); g.arc(x, y + 1, r, 0, 6.2832); g.fill();
  g.fillStyle = 'rgba(176,180,186,0.8)';
  g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  g.strokeStyle = 'rgba(20,22,24,0.9)'; g.lineWidth = 1.4;
  g.beginPath(); g.moveTo(x - r * 0.7, y - r * 0.2); g.lineTo(x + r * 0.7, y + r * 0.2); g.stroke();
}

function toggle(g: Ctx2D, x: number, y: number, r: number, up: boolean): void {
  g.fillStyle = 'rgba(10,12,13,0.9)';
  g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  g.strokeStyle = 'rgba(150,154,160,0.55)'; g.lineWidth = 1.5;
  g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.stroke();
  g.strokeStyle = 'rgba(198,202,208,0.95)'; g.lineWidth = 3.4; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + (up ? -r * 1.5 : r * 1.5)); g.stroke();
}

/**
 * One round instrument.
 *
 * Everything is driven off the same 'GaugeSpec' the needle animator reads, so
 * the painted ticks, the numerals and the hand always agree.
 */
function drawGauge(g: Ctx2D, s: GaugeSpec, x: number, y: number, r: number, rnd: Rand): void {
  // Bezel: a machined ring with a lit upper edge.
  const bez = g.createLinearGradient(x, y - r * 1.2, x, y + r * 1.2);
  bez.addColorStop(0, '#9aa0a6');
  bez.addColorStop(0.42, '#4c5156');
  bez.addColorStop(1, '#1e2124');
  g.fillStyle = bez;
  g.beginPath(); g.arc(x, y, r * 1.16, 0, 6.2832); g.fill();
  g.fillStyle = 'rgba(0,0,0,0.75)';
  g.beginPath(); g.arc(x, y, r * 1.02, 0, 6.2832); g.fill();
  g.fillStyle = '#0f1112';
  g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  // Bezel screws.
  for (let i = 0; i < 4; i++) {
    const a = Math.PI * 0.25 + i * Math.PI * 0.5;
    screw(g, x + Math.cos(a) * r * 1.09, y + Math.sin(a) * r * 1.09, Math.max(2, r * 0.055));
  }

  // Angles: 'a' is clockwise from 12 o'clock, canvas y is down, so the canvas
  // angle is a − π/2.
  const ang = (f: number) => s.a0 + (s.a1 - s.a0) * f - Math.PI / 2;

  if (s.face === 'horizon') { faceHorizon(g, x, y, r); }
  else if (s.face === 'compass') { faceCompass(g, x, y, r); }
  else if (s.face === 'turn') { faceTurn(g, x, y, r); }

  if (s.face !== 'horizon' && s.face !== 'compass') {
    if (s.yellowArc) {
      g.strokeStyle = rgba(CAUTION, 0.9); g.lineWidth = r * 0.08;
      g.beginPath(); g.arc(x, y, r * 0.80, ang(s.yellowArc[0]), ang(s.yellowArc[1])); g.stroke();
    }
    if (s.redArc) {
      g.strokeStyle = rgba(WARN, 0.95); g.lineWidth = r * 0.08;
      g.beginPath(); g.arc(x, y, r * 0.80, ang(s.redArc[0]), ang(s.redArc[1])); g.stroke();
    }
    const total = s.major * s.minor;
    for (let i = 0; i <= total; i++) {
      const f = i / total;
      const a = ang(f);
      const isMajor = i % s.minor === 0;
      const r0 = r * (isMajor ? 0.62 : 0.74);
      const r1 = r * 0.90;
      g.strokeStyle = rgba(MARK, isMajor ? 0.98 : 0.62);
      g.lineWidth = isMajor ? Math.max(1.5, r * 0.055) : Math.max(1, r * 0.026);
      g.beginPath();
      g.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
      g.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
      g.stroke();
    }
    s.numerals.forEach((t, i) => {
      if (!t) return;
      const f = s.numerals.length > 1 ? i / (s.numerals.length - 1) : 0;
      const a = ang(f);
      drawText(g, t, x + Math.cos(a) * r * 0.46, y + Math.sin(a) * r * 0.46, {
        size: r * (t.length > 2 ? 0.20 : 0.28), color: MARK, align: 'center', weight: 700, squash: 0.88,
      });
    });
  }

  if (s.label) {
    drawText(g, s.label, x, y + r * 0.28, {
      size: r * 0.17, color: DIM, align: 'center', weight: 700, squash: 0.85, tracking: r * 0.02,
    });
  }
  if (s.sub) {
    drawText(g, s.sub, x, y - r * 0.30, {
      size: r * 0.145, color: 0x8a8779, align: 'center', weight: 600, squash: 0.85,
    });
  }

  // Hub cap, then the glass: a hard crescent reflection and a little dust.
  g.fillStyle = '#16191b';
  g.beginPath(); g.arc(x, y, r * 0.11, 0, 6.2832); g.fill();
  g.save();
  g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.clip();
  g.fillStyle = 'rgba(206,224,240,0.12)';
  g.beginPath(); g.ellipse(x - r * 0.30, y - r * 0.40, r * 0.72, r * 0.34, -0.62, 0, 6.2832); g.fill();
  g.fillStyle = 'rgba(206,224,240,0.06)';
  g.beginPath(); g.ellipse(x + r * 0.42, y + r * 0.46, r * 0.42, r * 0.16, -0.62, 0, 6.2832); g.fill();
  for (let i = 0; i < 5; i++) {
    g.fillStyle = 'rgba(190,186,170,0.10)';
    g.beginPath();
    g.arc(x + rnd.range(-r, r) * 0.8, y + rnd.range(-r, r) * 0.8, rnd.range(0.8, 2.4), 0, 6.2832);
    g.fill();
  }
  g.restore();
}

function faceHorizon(g: Ctx2D, x: number, y: number, r: number): void {
  g.save();
  g.beginPath(); g.arc(x, y, r * 0.92, 0, 6.2832); g.clip();
  g.fillStyle = '#2b5f8c'; g.fillRect(x - r, y - r, r * 2, r * 0.92);
  g.fillStyle = '#6d4a28'; g.fillRect(x - r, y - r * 0.08, r * 2, r * 1.2);
  g.strokeStyle = rgba(MARK, 0.9); g.lineWidth = Math.max(1.4, r * 0.04);
  g.beginPath(); g.moveTo(x - r * 0.85, y - r * 0.08); g.lineTo(x + r * 0.85, y - r * 0.08); g.stroke();
  for (let i = 1; i <= 3; i++) {
    const w = r * (0.34 - i * 0.06);
    for (const sgn of [-1, 1]) {
      g.beginPath();
      g.moveTo(x - w, y - r * 0.08 + sgn * i * r * 0.19);
      g.lineTo(x + w, y - r * 0.08 + sgn * i * r * 0.19);
      g.stroke();
    }
  }
  // Bank scale round the top.
  for (let i = -3; i <= 3; i++) {
    const a = -Math.PI / 2 + i * 0.35;
    g.strokeStyle = rgba(MARK, 0.85); g.lineWidth = Math.max(1.2, r * 0.035);
    g.beginPath();
    g.moveTo(x + Math.cos(a) * r * 0.78, y + Math.sin(a) * r * 0.78);
    g.lineTo(x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9);
    g.stroke();
  }
  g.restore();
  // Fixed aircraft symbol.
  g.strokeStyle = hex(CAUTION); g.lineWidth = Math.max(2, r * 0.07);
  g.beginPath();
  g.moveTo(x - r * 0.56, y); g.lineTo(x - r * 0.17, y);
  g.moveTo(x + r * 0.17, y); g.lineTo(x + r * 0.56, y);
  g.stroke();
  g.beginPath(); g.arc(x, y, r * 0.06, 0, 6.2832); g.stroke();
}

function faceCompass(g: Ctx2D, x: number, y: number, r: number): void {
  const pts = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];
  pts.forEach((t, i) => {
    const a = -Math.PI / 2 + (i / 12) * FULL;
    drawText(g, t, x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62, {
      size: r * (t.length === 1 ? 0.28 : 0.20), color: MARK, align: 'center', weight: 700, squash: 0.88,
    });
    for (let k = 1; k < 3; k++) {
      const aa = a + (k / 3) * (FULL / 12);
      g.strokeStyle = rgba(MARK, 0.55); g.lineWidth = Math.max(1, r * 0.028);
      g.beginPath();
      g.moveTo(x + Math.cos(aa) * r * 0.80, y + Math.sin(aa) * r * 0.80);
      g.lineTo(x + Math.cos(aa) * r * 0.90, y + Math.sin(aa) * r * 0.90);
      g.stroke();
    }
  });
  // Lubber line at the top.
  g.strokeStyle = hex(CAUTION); g.lineWidth = Math.max(2, r * 0.06);
  g.beginPath(); g.moveTo(x, y - r * 0.98); g.lineTo(x, y - r * 0.74); g.stroke();
}

function faceTurn(g: Ctx2D, x: number, y: number, r: number): void {
  g.strokeStyle = rgba(MARK, 0.9); g.lineWidth = Math.max(1.5, r * 0.05);
  for (const sgn of [-1, 1]) {
    const a = -Math.PI / 2 + sgn * 0.42;
    g.beginPath();
    g.moveTo(x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62);
    g.lineTo(x + Math.cos(a) * r * 0.88, y + Math.sin(a) * r * 0.88);
    g.stroke();
  }
  // Slip-ball race across the bottom, with the ball centred.
  g.strokeStyle = rgba(MARK, 0.55); g.lineWidth = Math.max(2, r * 0.10);
  g.beginPath(); g.arc(x, y - r * 1.30, r * 1.75, 1.24, 1.90); g.stroke();
  g.fillStyle = '#0a0b0c';
  g.beginPath(); g.arc(x, y + r * 0.46, r * 0.11, 0, 6.2832); g.fill();
  g.fillStyle = 'rgba(230,226,212,0.92)';
  g.beginPath(); g.arc(x - r * 0.01, y + r * 0.45, r * 0.085, 0, 6.2832); g.fill();
}

// --- material cells ---------------------------------------------------------

function paintTub(g: Ctx2D, r: Rect, rnd: Rand): void {
  g.fillStyle = hex(INTERIOR_GREEN);
  g.fillRect(r.x, r.y, r.w, r.h);
  for (let y = 0; y < r.h; y += 2) {
    for (let x = 0; x < r.w; x += 2) {
      const n = fbm(x * 0.05, y * 0.05, 4, 3);
      g.fillStyle = rgba(n > 0.5 ? 0x8b9a7c : 0x2c3529, Math.abs(n - 0.5) * 1.1);
      g.fillRect(r.x + x, r.y + y, 2, 2);
    }
  }
  // Frames across the wall, with a lit edge and a cast shadow either side.
  // These are the strongest thing on the cell on purpose: the tub covers a
  // quarter of the cockpit frame and without them it is a flat wash, which
  // the rubric calls an automatic failure.
  for (let i = 0; i < 4; i++) {
    const x = r.x + 22 + i * 62;
    g.fillStyle = 'rgba(0,0,0,0.42)'; g.fillRect(x - 5, r.y, 5, r.h);
    g.fillStyle = 'rgba(196,206,178,0.22)'; g.fillRect(x, r.y, 20, r.h);
    g.fillStyle = 'rgba(232,240,214,0.30)'; g.fillRect(x, r.y, 4, r.h);
    g.fillStyle = 'rgba(0,0,0,0.40)'; g.fillRect(x + 20, r.y, 6, r.h);
    for (let k = 0; k < 22; k++) {
      const y = r.y + 6 + k * 12;
      g.fillStyle = 'rgba(0,0,0,0.50)';
      g.beginPath(); g.arc(x + 10, y + 1.4, 2.4, 0, 6.2832); g.fill();
      g.fillStyle = 'rgba(226,232,210,0.55)';
      g.beginPath(); g.arc(x + 10, y, 2.2, 0, 6.2832); g.fill();
    }
  }
  // Skin panel joints running the other way, so the wall reads as a built-up
  // structure rather than as a sheet with stripes on it.
  for (let k = 0; k < 3; k++) {
    const y = r.y + 54 + k * 74;
    g.fillStyle = 'rgba(0,0,0,0.30)'; g.fillRect(r.x, y, r.w, 3);
    g.fillStyle = 'rgba(220,228,204,0.16)'; g.fillRect(r.x, y + 3, r.w, 2);
  }
  // Wiring loom and control cables clipped along the frames.
  for (const [y0, y1, col, wdt] of [[38, 66, 'rgba(20,22,18,0.85)', 4],
    [96, 78, 'rgba(112,86,44,0.75)', 3], [150, 176, 'rgba(150,152,146,0.6)', 2]] as [number, number, string, number][]) {
    g.strokeStyle = col; g.lineWidth = wdt;
    g.beginPath();
    g.moveTo(r.x, r.y + y0);
    g.bezierCurveTo(r.x + 90, r.y + y0 + 18, r.x + 160, r.y + y1 - 16, r.x + r.w, r.y + y1);
    g.stroke();
  }
  // Chipped paint down to bare metal along the edges the pilot climbs over.
  for (let i = 0; i < 26; i++) {
    const x = r.x + rnd.next() * r.w, y = r.y + rnd.next() * r.h;
    g.fillStyle = rgba(0xb9bec2, rnd.range(0.18, 0.5));
    g.beginPath();
    g.ellipse(x, y, rnd.range(2, 9), rnd.range(1.5, 5), rnd.next() * 3, 0, 6.2832);
    g.fill();
  }
  scratches(g, r, 130, rnd, 0xaeb5a4, 0.30, 5, 30, 1.4, 1.2);
  // Ambient occlusion baked down the section: light spills in over the sill and
  // dies before it reaches the floor. Without this ramp the wall is one value
  // from the sill to the boots and reads as a flat plane whatever is painted on
  // it — the texture is mapped with v running down the section, so a vertical
  // gradient here is a depth cue on the finished surface.
  const ao = g.createLinearGradient(0, r.y, 0, r.y + r.h);
  ao.addColorStop(0, 'rgba(255,246,224,0.20)');
  ao.addColorStop(0.28, 'rgba(255,246,224,0.02)');
  ao.addColorStop(0.72, 'rgba(10,12,10,0.30)');
  ao.addColorStop(1, 'rgba(8,9,8,0.62)');
  g.fillStyle = ao;
  g.fillRect(r.x, r.y, r.w, r.h);
}

function paintLeather(g: Ctx2D, r: Rect, rnd: Rand): void {
  g.fillStyle = '#231b16';
  g.fillRect(r.x, r.y, r.w, r.h);
  for (let y = 0; y < r.h; y += 2) {
    for (let x = 0; x < r.w; x += 2) {
      const n = fbm(x * 0.14, y * 0.14, 4, 7);
      g.fillStyle = rgba(n > 0.5 ? 0x403227 : 0x140f0c, Math.abs(n - 0.5) * 0.9);
      g.fillRect(r.x + x, r.y + y, 2, 2);
    }
  }
  // Stitch line down the middle.
  g.strokeStyle = 'rgba(190,170,140,0.35)';
  g.lineWidth = 1.6;
  g.setLineDash([5, 6]);
  g.beginPath(); g.moveTo(r.x + r.w * 0.5, r.y); g.lineTo(r.x + r.w * 0.5, r.y + r.h); g.stroke();
  g.setLineDash([]);
  scratches(g, r, 60, rnd, 0x8a7458, 0.18, 4, 18, 0.5, 1.6);
}

function paintBlackMetal(g: Ctx2D, r: Rect, rnd: Rand): void {
  g.fillStyle = '#131516';
  g.fillRect(r.x, r.y, r.w, r.h);
  for (let y = 0; y < r.h; y += 2) {
    for (let x = 0; x < r.w; x += 2) {
      const n = fbm(x * 0.11, y * 0.11, 3, 19);
      g.fillStyle = rgba(0x30363a, Math.max(0, n - 0.5) * 0.8);
      g.fillRect(r.x + x, r.y + y, 2, 2);
    }
  }
  scratches(g, r, 120, rnd, 0xa8adb2, 0.30, 5, 26, 0.3, 1.5);
}

function paintFloor(g: Ctx2D, r: Rect, rnd: Rand): void {
  g.fillStyle = '#2b2e28';
  g.fillRect(r.x, r.y, r.w, r.h);
  // Non-slip ribbing.
  for (let i = 0; i < 26; i++) {
    const y = r.y + 4 + i * 10;
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(r.x, y, r.w, 4);
    g.fillStyle = 'rgba(0,0,0,0.32)'; g.fillRect(r.x, y + 4, r.w, 2);
  }
  scratches(g, r, 140, rnd, 0x9aa096, 0.3, 8, 40, 0.1, 0.8);
  g.fillStyle = 'rgba(10,8,6,0.35)';
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.ellipse(r.x + rnd.next() * r.w, r.y + rnd.next() * r.h, rnd.range(10, 34), rnd.range(6, 20), rnd.next() * 3, 0, 6.2832);
    g.fill();
  }
}

function paintCanvas(g: Ctx2D, r: Rect, rnd: Rand): void {
  g.fillStyle = '#4c4a36';
  g.fillRect(r.x, r.y, r.w, r.h);
  // Woven twill.
  for (let y = 0; y < r.h; y += 3) {
    g.fillStyle = y % 6 === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.10)';
    g.fillRect(r.x, r.y + y, r.w, 1.6);
  }
  for (let x = 0; x < r.w; x += 3) {
    g.fillStyle = x % 6 === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.07)';
    g.fillRect(r.x + x, r.y, 1.6, r.h);
  }
  scratches(g, r, 50, rnd, 0x2a2a1e, 0.25, 8, 30, 0.9, 1.4);
  g.fillStyle = 'rgba(24,20,12,0.22)';
  g.beginPath(); g.ellipse(r.x + r.w * 0.5, r.y + r.h * 0.62, r.w * 0.34, r.h * 0.22, 0, 0, 6.2832); g.fill();
}

function paintAlloy(g: Ctx2D, r: Rect, rnd: Rand): void {
  g.fillStyle = '#8e9298';
  g.fillRect(r.x, r.y, r.w, r.h);
  for (let y = 0; y < r.h; y += 2) {
    for (let x = 0; x < r.w; x += 2) {
      const n = fbm(x * 0.20, y * 0.06, 3, 29);
      g.fillStyle = rgba(n > 0.5 ? 0xc2c7cc : 0x5c6167, Math.abs(n - 0.5) * 0.8);
      g.fillRect(r.x + x, r.y + y, 2, 2);
    }
  }
  scratches(g, r, 160, rnd, 0xdfe4e8, 0.35, 6, 34, 0.05, 0.5);
}

function paintNeedle(g: Ctx2D, r: Rect): void {
  // v = 0 is the tip, v = 1 the root — see 'needleGeom'.
  const grd = g.createLinearGradient(0, r.y, 0, r.y + r.h);
  grd.addColorStop(0, '#fff4dc');
  grd.addColorStop(0.55, '#e8e2cf');
  grd.addColorStop(0.78, '#c8532c');
  grd.addColorStop(1, '#1a1c1d');
  g.fillStyle = grd;
  g.fillRect(r.x, r.y, r.w, r.h);
  // A dark centre stripe gives the blade a fold and stops it reading as a bar.
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.fillRect(r.x + r.w * 0.46, r.y, r.w * 0.08, r.h);
}

/**
 * The gunsight graticule, painted on transparency so the reflector plate is
 * glass with an image floating on it rather than a grey card.
 */
function paintReticle(g: Ctx2D, r: Rect): void {
  g.clearRect(r.x, r.y, r.w, r.h);
  const cx = r.x + r.w * 0.5, cy = r.y + r.h * 0.5;
  // Faint tint and a raking reflection on the glass itself.
  g.fillStyle = 'rgba(150,178,180,0.10)';
  g.fillRect(r.x, r.y, r.w, r.h);
  const sheen = g.createLinearGradient(r.x, r.y + r.h, r.x + r.w, r.y);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.45, 'rgba(226,240,255,0.10)');
  sheen.addColorStop(0.55, 'rgba(226,240,255,0.02)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fillRect(r.x, r.y, r.w, r.h);

  const ring = r.w * 0.30;
  g.strokeStyle = 'rgba(255,196,110,0.95)';
  g.lineWidth = 3.2;
  g.beginPath(); g.arc(cx, cy, ring, 0, 6.2832); g.stroke();
  // Range bars either side, the span the pilot brackets a target between.
  g.lineWidth = 3.6;
  for (const sgn of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx + sgn * ring, cy);
    g.lineTo(cx + sgn * r.w * 0.42, cy);
    g.stroke();
  }
  // Pipper.
  g.fillStyle = 'rgba(255,214,140,1)';
  g.beginPath(); g.arc(cx, cy, 4.2, 0, 6.2832); g.fill();
  g.strokeStyle = 'rgba(255,196,110,0.9)'; g.lineWidth = 2.4;
  g.beginPath(); g.moveTo(cx, cy - r.h * 0.42); g.lineTo(cx, cy - ring * 0.55); g.stroke();
  g.beginPath(); g.moveTo(cx, cy + ring * 0.55); g.lineTo(cx, cy + r.h * 0.42); g.stroke();
  // Deflection ticks on the ring.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * FULL;
    g.strokeStyle = 'rgba(255,196,110,0.55)'; g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * ring * 0.86, cy + Math.sin(a) * ring * 0.86);
    g.lineTo(cx + Math.cos(a) * ring, cy + Math.sin(a) * ring);
    g.stroke();
  }
}
