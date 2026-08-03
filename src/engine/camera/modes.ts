/**
 * Camera modes and their tuning.
 *
 * Every constant here is a *feel* decision, so they live together where they
 * can be reasoned about as a set rather than being scattered through the rig
 * code. Distances are expressed as multiples of the aircraft's own length
 * wherever possible, so a bomber and a fighter frame identically without
 * per-aircraft tables.
 */

export type CameraMode =
  | 'chase'      // third-person boom, the default
  | 'cockpit'    // pilot's eye
  | 'gunsight'   // down the boresight, magnified
  | 'orbit'      // free mouse-drag orbit
  | 'flyby'      // fixed cinematic point the aircraft passes
  | 'killcam'    // orbit of a destroyed aircraft, slow-motion
  | 'scripted';  // driven by debugFraming / cutscenes

/** The order 'C' walks through. Kill-cam and scripted are entered by events. */
export const CYCLE_MODES: CameraMode[] = ['chase', 'cockpit', 'gunsight', 'orbit', 'flyby'];

export const MODE_LABELS: Record<CameraMode, string> = {
  chase: 'Third person',
  cockpit: 'Cockpit',
  gunsight: 'Gunsight',
  orbit: 'Free camera',
  flyby: 'Fly-by',
  killcam: 'Kill cam',
  scripted: 'Cinematic',
};

export interface ChaseParams {
  /** Boom length as a multiple of aircraft length. */
  distanceMul: number;
  /** Boom height above the aircraft, as a multiple of aircraft length. */
  heightMul: number;
  /** How far the boom swings from the nose toward the flight path. 0 = nose, 1 = velocity. */
  velocityBias: number;
  /** Fraction of the aircraft's bank the camera copies. */
  rollFollow: number;
  /** Position spring frequency, Hz, and damping. */
  posFreq: number;
  posDamping: number;
  /** Look-target spring. */
  lookFreq: number;
  lookDamping: number;
  /** Vertical framing: the look point rises by this fraction of the boom length,
   *  which pushes the aircraft down toward the lower third of frame. */
  frameLift: number;
  /** Look-ahead along the flight path, as a multiple of boom length. */
  lookAhead: number;
  /** Lateral lead into the turn, metres per rad/s of yaw rate. */
  turnLead: number;
  /** Extra boom stretch under acceleration, metres per m/s². */
  accelStretch: number;
  /** Minimum clearance kept above the terrain, metres. */
  terrainClearance: number;
  /** FOV at rest, and the extra degrees added at high speed. */
  baseFov: number;
  speedFov: number;
  /** Speed, m/s, at which the FOV widening saturates. */
  speedFovRef: number;
}

export const CHASE: ChaseParams = {
  distanceMul: 2.05,
  heightMul: 0.44,
  velocityBias: 0.55,
  rollFollow: 0.30,
  posFreq: 2.35,
  posDamping: 1.0,
  lookFreq: 3.4,
  lookDamping: 1.0,
  frameLift: 0.155,
  lookAhead: 1.5,
  turnLead: 5.2,
  accelStretch: 0.16,
  terrainClearance: 4.0,
  baseFov: 62,
  speedFov: 13,
  speedFovRef: 235,
};

export interface CockpitParams {
  /** Eye position in body space if the model provides no pilot node. */
  eyeForwardBias: number;   // 0 = canopy forward edge (z0), 1 = aft edge (z1)
  eyeHeight: number;        // fraction of canopy height above the fuselage line
  /**
   * Seat adjustment, metres, applied on top of the eye point the model
   * publishes. Composition, not geometry — but on a very short leash.
   *
   * Measured on the Spitfire rig (all airframes are built by the same code, to
   * the same proportions of the fuselage radius):
   *
   *     cockpit interior shell, top ....  y = 0.670   ← ceiling
   *     gunsight reflector glass .......  y = 0.639
   *     model's published eye point ....  y = 0.589
   *     coaming, top ...................  y = 0.544
   *     instrument panel, top ..........  y = 0.451
   *     instrument panel, bottom .......  y = 0.200
   *
   * At +0.035 the reflector sight lands within two degrees of the screen
   * centre and the canopy hood frames the upper corners, which is the
   * composition every shipped WWII sim uses. 'forward' moves the eye to the
   * front of the skull (the model's anchor is the head's centre) and past the
   * goggles, so the helmet is behind the lens.
   *
   * KNOWN BLOCKER, and it is not in this file's gift to fix: the panel is
   * geometrically in the right place — it projects to 65…88 % of frame height,
   * exactly the lower third — but it is never drawn, because BOTH the fuselage
   * skin ('hull') and the cockpit liner ('cockpitInterior') are closed surfaces
   * with no cockpit aperture cut in them, and the panel sits inside both. This
   * was verified by hiding each in turn at runtime: hide only 'hull' and the
   * liner still occludes; hide only the liner and the skin still occludes; hide
   * both and the full instrument panel appears, dials, needles and all. Sweeping
   * the seat height from −0.13 to +0.09 does not help, because the fuselage top
   * runs level with the eye all the way to the spinner, so the decking's
   * silhouette sits on the eye line at every seat position. The fix belongs in
   * src/assets/aircraft — see the report.
   */
  seatRaise: number;
  seatForward: number;
  /** Head displacement per g, metres. Real pilots sink about 2 cm per g. */
  headThrowPerG: number;
  maxHeadThrow: number;
  /** Head lag under angular acceleration, metres per rad/s. */
  headLagPerRate: number;
  /** Spring on the head. Deliberately soft — the head is heavy. */
  headFreq: number;
  headDamping: number;
  baseFov: number;
  zoomFov: number;
  /** Free-look limits, radians. */
  yawLimit: number;
  pitchLimit: number;
  /** How fast the head snaps back when free-look is released. */
  recenterRate: number;
  /** Near clip for the cockpit pass — the panel is centimetres from the eye. */
  near: number;
}

export const COCKPIT: CockpitParams = {
  eyeForwardBias: 0.28,
  eyeHeight: 0.42,
  seatRaise: 0.035,
  seatForward: 0.13,
  headThrowPerG: 0.021,
  maxHeadThrow: 0.115,
  headLagPerRate: 0.030,
  headFreq: 1.9,
  headDamping: 0.85,
  baseFov: 68,
  zoomFov: 34,
  yawLimit: 2.62,        // 150° — you can look over your shoulder, not behind
  pitchLimit: 1.22,
  recenterRate: 7.5,
  near: 0.06,
};

export interface GunsightParams {
  /** Offset from the eye along the bore, metres. Positive moves toward the sight glass. */
  setback: number;
  baseFov: number;
  zoomFov: number;
  /** How much of the airframe's angular motion leaks into the sight. 0 = rigid. */
  compliance: number;
}

export const GUNSIGHT: GunsightParams = {
  setback: 0.22,
  baseFov: 40,
  zoomFov: 17,
  compliance: 0.10,
};

export interface OrbitParams {
  minDistanceMul: number;
  maxDistanceMul: number;
  defaultDistanceMul: number;
  /** Radians per pixel of drag. */
  dragSensitivity: number;
  /** Zoom multiplier per wheel notch. */
  zoomStep: number;
  /** Elevation clamp so the camera never flips over the pole. */
  elevationLimit: number;
  freq: number;
  damping: number;
  fov: number;
}

export const ORBIT: OrbitParams = {
  minDistanceMul: 0.9,
  maxDistanceMul: 14,
  defaultDistanceMul: 3.1,
  dragSensitivity: 0.0042,
  zoomStep: 1.16,
  elevationLimit: 1.48,
  freq: 5.0,
  damping: 1.0,
  fov: 58,
};

export interface FlybyParams {
  /** How far ahead of the aircraft the camera station is placed, in seconds of flight. */
  leadSeconds: number;
  minLead: number;
  /** Lateral and vertical offset ranges for the station, metres. */
  lateral: [number, number];
  vertical: [number, number];
  /** Re-station once the aircraft is this far past, metres. */
  passDistance: number;
  /** Maximum station lifetime, seconds. */
  maxDwell: number;
  fov: number;
  /** Slow dolly speed, m/s — a locked-off camera looks like a render. */
  dolly: number;
  lookFreq: number;
}

export const FLYBY: FlybyParams = {
  leadSeconds: 2.6,
  minLead: 180,
  lateral: [40, 130],
  vertical: [-45, 55],
  passDistance: 420,
  maxDwell: 9,
  fov: 46,
  dolly: 3.5,
  lookFreq: 2.6,
};

export interface KillcamParams {
  duration: number;
  /** Orbit rate, rad/s. */
  spin: number;
  distanceMul: number;
  heightMul: number;
  /** Time-scale ramp: starts here and returns to 1 over the duration. */
  slowMo: number;
  slowMoHold: number;
  fov: number;
}

export const KILLCAM: KillcamParams = {
  duration: 4.2,
  spin: 0.42,
  distanceMul: 3.4,
  heightMul: 0.55,
  slowMo: 0.28,
  slowMoHold: 1.5,
  fov: 52,
};

/**
 * Screen effects the camera hands to the render composer each frame. All are
 * normalised 0…1 except where noted, so the render side can map them onto
 * whatever its passes actually want.
 */
export interface ScreenEffects {
  /** Positive = grey-out/blackout (positive g), negative = redout. */
  gEffect: number;
  /** Vignette strength beyond the artistic base. */
  vignette: number;
  /** Radial blur amount — speed and g both feed it. */
  radialBlur: number;
  /** Centre of the radial blur in NDC. */
  blurCenterX: number;
  blurCenterY: number;
  /** Chromatic aberration multiplier. */
  chromatic: number;
  /** Motion-blur scale hint. */
  motionBlur: number;
  /** Camera shake magnitude, for any post effect that wants to react. */
  shake: number;
  /** Current field of view, degrees — handy for HUD scaling. */
  fov: number;
  /** True while the cockpit interior needs its own near pass. */
  interior: boolean;
  /** 0…1 desaturation, used by the kill-cam. */
  desaturate: number;
  /** Time scale the camera would like the simulation to run at. */
  timeScale: number;
}

export function newScreenEffects(): ScreenEffects {
  return {
    gEffect: 0, vignette: 0, radialBlur: 0, blurCenterX: 0, blurCenterY: 0,
    chromatic: 1, motionBlur: 1, shake: 0, fov: 62, interior: false,
    desaturate: 0, timeScale: 1,
  };
}
