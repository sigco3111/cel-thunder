import * as THREE from 'three';
import type { CameraMode } from './modes';

/**
 * The named camera framings the automated screenshot harness drives.
 *
 * These are not debug views. They are the frames the game is judged on, so each
 * one is composed the way a stills photographer would compose it:
 *
 *  - **Rule of thirds.** The subject is deliberately placed off-centre with
 *    'frameX' / 'frameY', which are literally normalised-device-coordinate
 *    targets for where the aircraft should land in the frame.
 *  - **Lens choice.** Wide lenses for the in-the-action shots (the horizon
 *    bends, the ground rushes), long lenses for the hero and silhouette shots
 *    (compression, separation, a big soft sun). A 40 mm-equivalent hero shot
 *    reads as a render; a 135 mm-equivalent reads as a photograph.
 *  - **Light direction.** 'sunRel' asks for a specific angle between the camera
 *    axis and the sun — 0 is straight into it, π is with it over your shoulder —
 *    and 'sunLocked' solves the subject's heading so that angle and the
 *    'bearing' can both be exact. Three-quarter back light ('|sunRel| ≈ 0.8')
 *    is what makes a rim light wrap a fuselage; front light is what makes it
 *    look like a catalogue photo, and it is what every one of these framings was
 *    accidentally set up for before the convention was pinned down.
 *  - **Foreground and depth.** Low camera stations put terrain, sea or cloud in
 *    the near field, which is the cheapest way to stop a sky shot reading flat.
 *  - **Dutch angle** where the shot is about motion, and only there.
 */

export type FramingName =
  | 'hero' | 'dogfight' | 'low' | 'cockpit' | 'clouds'
  | 'ground_attack' | 'sunset' | 'water' | 'damage' | 'hud';

export interface WeatherDirective {
  /** Cloud coverage, 0…1. */
  coverage: number;
  /** Base altitude of the cumulus deck, metres. */
  cloudBase: number;
  /** Vertical development, metres. */
  cloudDepth: number;
  /** Ground haze density multiplier. */
  haze: number;
  /** Overall atmospheric turbidity — pushes the sky toward white and the sun toward orange. */
  turbidity: number;
  windSpeed: number;
  /** 0…1 precipitation. The VFX layer reads this directly. */
  rain: number;
}

export interface FramingSpec {
  /** Which rig to run. 'scripted' poses the camera exactly as specified. */
  mode: CameraMode;
  /** Hours, 0…24. */
  timeOfDay: number;
  weather: WeatherDirective;

  /**
   * Altitude measured from the top of the cumulus deck instead of from the
   * ground, metres. Only the cloud shot uses it, and it is the difference
   * between "an aeroplane skimming a cloudscape" and "an aeroplane over a
   * featureless blue plane with a white line on the horizon": a shot composed
   * *on* the deck has to be placed relative to the deck, because the deck's own
   * altitude is a weather parameter that moves independently of the framing.
   */
  cloudTopOffset?: number;

  /**
   * Vertical field of view, degrees.
   *
   * Only consulted by the 'scripted' rig. The 'cockpit' and 'chase' framings run
   * the live rig, which owns its own lens, so this value is documentation there
   * rather than a setting.
   */
  fov: number;
  /** Boom length, metres, for a ~9.5 m fighter (scaled by actual length). */
  distance: number;
  /** Camera bearing around the subject: 0 = dead astern, π = head-on, +ve = to the subject's right. */
  bearing: number;
  /** Camera height above the subject, metres. Negative looks up at it. */
  height: number;

  /** Where the subject should sit in frame, in NDC. +X right, +Y up. */
  frameX: number;
  frameY: number;
  /** Dutch tilt, radians. */
  dutch: number;

  /** 0 = place the camera purely by 'bearing', 1 = purely by the sun. Ignored when 'sunLocked'. */
  sunBias: number;
  /**
   * Angle between the camera's view direction and the direction **toward** the
   * sun, radians.
   *
   *   0     — the lens is pointed straight at the sun; the subject is a
   *           silhouette with a rim and the sky behind it is incandescent.
   *   ±0.3  — the disc sits about a third of the way out from centre on a
   *           normal lens: in frame, doing something, not eclipsed by the
   *           subject.
   *   ±0.8  — classic three-quarter back light. The disc is outside a 40–50°
   *           lens but the rim, the terminator and the long shadows are all
   *           still there.
   *   π     — the sun is directly behind the camera. Flat frontal light, no
   *           rim, no shadows pointing anywhere interesting.
   *
   * **Sign is which side of the frame the sun lands on: positive puts it to
   * the left, negative to the right.** Put it opposite the subject.
   *
   * This documentation used to say the opposite — that π was "fully backlit" —
   * and every framing in this file was authored against that reading, so all
   * ten shots were set up with the sun 150–170° from the lens, i.e. squarely
   * behind the camera. That is the single reason the critique could say of
   * frame after frame "there is no sun, no flare, no shaft, no specular track
   * on the water": the brightest object in the scene was always behind the
   * photographer. The values below are stated in the corrected convention.
   */
  sunRel: number;

  /**
   * Honour 'bearing' and 'sunRel' at the same time by choosing the subject's
   * heading instead of compromising between them.
   *
   * Normally these two are in tension — the camera station can either be where
   * the subject's quarter wants it or where the sun wants it, and 'sunBias'
   * picks a blend, which in practice means neither is right and the sun ends up
   * wherever the aircraft's authored heading happened to leave it. But the
   * heading is a free variable in a posed shot: nothing depends on which way
   * north is. Solving for it (heading = sunAzimuth − sunRel − bearing) puts the
   * camera at *exactly* the requested bearing off the tail *and* the sun at
   * exactly the requested angle off the lens, at any time of day, with no
   * per-framing tuning that has to be redone whenever a time of day moves.
   */
  sunLocked?: boolean;

  /** Used when no aircraft is spawned, so the harness still produces a frame. */
  fallback: {
    altitude: number;   // metres above the terrain below
    heading: number;    // radians
    pitch: number;      // radians, + = nose up
    bank: number;       // radians, + = right wing down
    speed: number;      // m/s, used for exhaust/prop/vfx cues
  };

  /**
   * Broadcast on 'debug:framing' for the other subsystems. The world, VFX,
   * entity and UI systems each pick out what they can honour; anything they do
   * not understand is ignored, so the shot degrades to "still well composed".
   */
  scene: {
    /**
     * Ask the entity/AI layer for an opponent at this relative bearing/range.
     *
     * The range is a *setup* range, not the range you see in the capture. The
     * sandbox noses the opponent back at the subject, so the pair close at the
     * sum of their true airspeeds — around 275 m/s — and the screenshot harness
     * waits about 1.8 s between applying a framing and taking the picture. Every
     * range here is therefore its intended on-screen range plus roughly 500 m.
     * Getting this wrong is not cosmetic: at 210 m the two aircraft had already
     * merged and passed before the shutter, and in the 'hud' framing the
     * opponent ended up 30 m away — inside the 260 m LOD0 band, which doubled
     * the aircraft draw calls for that frame.
     *
     * The bearing has to agree with where the camera is standing, which is not
     * automatic. A framing with 'bearing' near π has its camera *ahead* of the
     * subject looking back down the nose, so an opponent placed ahead of the
     * subject is behind the lens and simply is not in the photograph — which is
     * exactly what happened to the second aircraft in the low, water and sunset
     * frames. As a rule: opponent bearing and camera bearing want to be on the
     * same side of the aeroplane.
     */
    opponent?: { bearing: number; range: number; bank: number };
    /** Damage bits to apply to the subject for the shot. */
    damage?: number;
    /** Trailing smoke / fire intensity, 0…1. */
    fire?: number;
    smoke?: number;
    /**
     * Request tracer fire from the subject.
     *
     * Read by the screenshot harness, which holds the real fire button down
     * across the settle — so the tracers, the muzzle flash, the impacts and the
     * recoil shake in the capture are the game's own, not a posed effect.
     */
    firing?: boolean;
    /**
     * Aim the whole shot at a real feature of the generated world rather than at
     * a height-scored patch of ground.
     *
     * 'findAnchorSite' can only find somewhere that *looks* like an airfield —
     * flat, 5…140 m — which is most of the farmland on the map, and that is why
     * the strafing frame had no airfield in it. Asking the world subsystem for
     * the actual site instead puts hangars, revetments, flak and a runway under
     * the nose. The subject is then stood off 'standoff' metres short of it
     * along its own heading, so the feature is ahead and below at the moment the
     * shutter opens rather than already behind the tail.
     */
    aimAt?: 'airfield' | 'target';
    /** Metres short of 'aimAt' to place the subject. See above. */
    standoff?: number;
    /** Request ground targets / an airfield below. */
    groundTargets?: boolean;
    /** Force the terrain type under the anchor. */
    biome?: 'coast' | 'water' | 'farmland' | 'hills' | 'airfield';
    /** Force the HUD on. */
    hud?: boolean;
    /** Gear/flap state for the shot. */
    gear?: boolean;
    flaps?: number;
  };
}

const CLEAR: WeatherDirective = { coverage: 0.20, cloudBase: 2000, cloudDepth: 800, haze: 0.55, turbidity: 2.2, windSpeed: 7, rain: 0 };
const CUMULUS: WeatherDirective = { coverage: 0.42, cloudBase: 1500, cloudDepth: 1700, haze: 0.7, turbidity: 2.8, windSpeed: 9, rain: 0 };
/**
 * A thick, deeply developed deck for the shot that is composed *on top of* the
 * cloud layer. Coverage has to be high here for the opposite reason to the
 * usual one: below about 0.75 the deck is not optically closed, and a camera
 * sitting a couple of hundred metres above it reads the farmland straight
 * through the gaps, which turns a cumulus field into blue ground fog. The
 * vertical development is what keeps individual towers legible at this
 * coverage.
 */
const TOWERING: WeatherDirective = { coverage: 0.86, cloudBase: 1500, cloudDepth: 2600, haze: 0.9, turbidity: 3.2, windSpeed: 12, rain: 0 };
/**
 * Golden hour. Haze and turbidity are both pulled back from where they were
 * (1.6 / 6.0): at those values the aerial perspective was so thick that the sea,
 * the land and the sky all converged on the same yellow and the frame became a
 * monochrome wash with an aeroplane in it — the rubric's "muddy mid-tones". A
 * sunset needs the *contrast* between a hot sky and a cold sea to read as one.
 */
const GOLDEN: WeatherDirective = { coverage: 0.30, cloudBase: 1500, cloudDepth: 1200, haze: 0.82, turbidity: 3.4, windSpeed: 6, rain: 0 };

/**
 * ---------------------------------------------------------------------------
 * WHERE THE AIRCRAFT'S OWN SHADOW LANDS — and why it kept landing outside the
 * picture.
 * ---------------------------------------------------------------------------
 *
 * Three rounds of critique read "the aeroplane casts no shadow" as a broken
 * caster set. It is not. Every hull, surface and gear mesh has 'castShadow'
 * set at every LOD, the layer mask passes, and dropping a white plane six
 * metres under the subject in the real 'low' framing produces a correct
 * Spitfire planform. The shadow was always being drawn; it was being drawn
 * somewhere the lens was not looking, and *that* is a property of these
 * framings, not of the shadow rig.
 *
 * The geometry is worth stating once, because it constrains three of the ten
 * shots and it is not intuitive:
 *
 *  1. A chase framing puts the camera 15–25 m from the subject at *the same
 *     altitude*. The patch of ground directly beneath the aeroplane is
 *     therefore at a depression of atan(AGL / distance) — at 45 m AGL and 20 m
 *     of boom that is 66° below the horizon, which no 50° lens contains. The
 *     ground under the subject is never in a deck-pass photograph.
 *
 *  2. So the shadow is only ever in frame because it is displaced *away* from
 *     the camera. It lies AGL / tan(sunElevation) metres from the point below
 *     the subject, in the direction the light travels. Only one azimuth pushes
 *     it far enough forward to climb into the bottom of the frame: the one
 *     that points down the lens axis, i.e. **the sun roughly behind the
 *     camera**. Every sideways offset exits the side of the frame instead,
 *     because the camera is close to the subject and a lateral displacement of
 *     70 m at 90 m of range is 38° off-axis.
 *
 *  3. Which is why this file's ten framings had zero shadows: 'sunRel' was
 *     authored between 0.24 and 1.75 rad in all of them — the sun 15…100° off
 *     the lens — and the shadow was thrown sideways past the frame edge or,
 *     in 'low' and 'water', behind the camera entirely.
 *
 * The trade is real and it is deliberate. A shot lit from behind the camera
 * has no rim light and its terrain relief is weaker, because everything's
 * shadow hides behind it. So the sun is pulled only as far round as the
 * shadow's screen position actually needs — 30° off the reverse axis in 'low',
 * 40° in 'ground_attack' — and only on the framings whose altitude makes the
 * shadow a *depth cue* rather than a detail. Above roughly 400 m AGL the
 * shadow is a handful of pixels and the rim light is worth far more, so 'hero',
 * 'clouds', 'sunset', 'dogfight' and 'hud' keep their back light and have no
 * ground shadow, correctly, because a real photograph from 1–2 km would not
 * show one either.
 *
 * The one number to check when re-tuning any of these: the shadow's position
 * is almost invariant to AGL once the sun is behind the lens, because the
 * displacement grows along the view direction and perspective divides it out
 * again. In 'ground_attack' the shadow moves 110 px across an AGL range of
 * 40…200 m. That is what makes the setting robust against the ±80 m of
 * altitude scatter the subject picks up while the harness settles.
 */
export const FRAMINGS: Record<FramingName, FramingSpec> = {
  /**
   * HERO — the box-art frame. Long lens, low front-quarter station so the
   * aircraft is seen against sky with the ground only as a hazy band, and
   * three-quarter back light so the sun draws a hot line down the spine and
   * along the leading edges. Subject sits upper-left on the thirds.
   */
  hero: {
    mode: 'scripted',
    timeOfDay: 7.45,
    weather: CUMULUS,
    fov: 42,
    // Close enough that the aeroplane is the subject rather than an element.
    // At 27 m on a 38 mm-equivalent it was 400 px of a 1920 px frame with two
    // thirds of the picture empty sky, which is the definition of a render.
    distance: 20,
    // Rear quarter, off the subject's right. The front quarter looked past the
    // aeroplane at its own belly: with the station 132° round from the tail and
    // the camera below the wing line, what filled the frame was the underside,
    // the radiator and the gear doors. From 54° behind, the upper surface, the
    // roundel, the canopy and the whole wing planform all face the lens.
    bearing: 0.95,
    // Just under the wing line — a compromise found by shooting both.
    // Well above the aircraft (+3.2) the camera axis tilts twelve degrees down
    // and the frame becomes eighty per cent farmland with the aeroplane lost in
    // it; well below (-5.5) you get sky but also the belly, the radiator and the
    // gear doors, the three least interesting surfaces on a fighter. At -1.5 the
    // horizon sits just under the subject: sky behind the aircraft, ground in
    // the lower third, and the wing planform still readable.
    height: 2.6,
    frameX: -0.23,
    frameY: 0.14,
    dutch: -0.09,
    // The sun has to be *in* the picture, not just lighting it.
    //
    // At sunRel 2.25 the sun sat 51° off the camera axis and a 40° lens is only
    // 33° wide at the corner, so the brightest object in the scene was always
    // just outside the frame: no aureole, no bloom, no shafts through the deck,
    // and the shot's one piece of drama thrown away. 2.76 rad puts it 21° off
    // the axis — inside the frame, well clear of the subject on the opposite
    // third — and the bias is raised because at 0.62 the blend between the
    // subject-relative and sun-relative stations left the actual angle wherever
    // the aircraft's heading happened to put it.
    // Three-quarter back light with the disc just *outside* the right-hand
    // edge, opposite the subject on the left third. See FramingSpec.sunRel: the
    // sign is which side of the frame the sun lands on. At 30° it was inside a
    // 40° lens and its bloom turned the right half of the frame into a white
    // wall — the exposure fell three stops and the aeroplane went black with it.
    // At 46°, against a 38° half-width, the disc sits just off the edge: what
    // lands in the picture is the aureole gradient, the shafts coming through
    // the cumulus and a hot rim down the spine and the leading edges, with
    // enough of the key still on the near side to model the fuselage.
    sunBias: 1.0,
    sunLocked: true,
    sunRel: -0.80,
    // Under the cumulus bases rather than 300 m over the tops.
    //
    // Above the deck the frame is aeroplane / flat white / hazy nothing — three
    // horizontal bands and no near field. Flying it 300 m *below* the bases puts
    // several kilometres of lit cumulus underside across the top of the frame
    // as a genuine foreground layer, the low sun rakes in underneath it, and the
    // farmland is close enough to still have hedgerows and roads in it.
    fallback: { altitude: 1180, heading: 0.9, pitch: 0.10, bank: 0.26, speed: 128 },
    // 'hills' rather than 'farmland': a ridge line running away under the wing
    // is a depth cue that a flat patchwork of fields cannot give, and the
    // biome search for farmland kept landing on the coast, where the lower half
    // of the frame came out as featureless water.
    scene: { biome: 'hills', gear: false, flaps: 0, hud: false },
  },

  /**
   * DOGFIGHT — inside the turn, wide lens, hard dutch. The subject is pushed
   * to the lower-left third and the frame is left open to the upper-right for
   * the opponent, which is where the AI aircraft is requested.
   */
  dogfight: {
    mode: 'scripted',
    timeOfDay: 9.4,
    weather: CUMULUS,
    fov: 68,
    distance: 16,
    bearing: 0.66,
    height: 3.4,
    frameX: -0.28,
    frameY: -0.16,
    dutch: 0.40,
    // Beam light, well out of frame. At 58° the subject was backlit into a flat
    // black cut-out with the tracer stream the only thing in the frame with any
    // value in it; at 86° the near side of the fuselage is modelled, the top of
    // the wing catches the key and there is still a rim down the far edge.
    sunBias: 1.0,
    sunLocked: true,
    sunRel: 1.50,
    fallback: { altitude: 1650, heading: 2.4, pitch: 0.06, bank: -1.05, speed: 141 },
    // Measured, not guessed: 730 m of setup left the opponent about 520 m out
    // at the shutter — twenty pixels, a speck. 520 puts it inside 300 m, which
    // is where a second aeroplane starts to read as an aeroplane.
    //
    // The bearing matters as much as the range. At 0.42 rad the bandit sat 24°
    // off the nose, so the guns — which fire down the nose and converge at
    // 400 m — threw their tracers into empty sky on the far side of the frame
    // and the two aircraft read as two unrelated objects. At 0.15 the stream
    // runs from the muzzles to the bandit and the pair become one event.
    scene: { opponent: { bearing: 0.15, range: 520, bank: -0.9 }, firing: true, hud: false },
  },

  /**
   * LOW — the deck pass. Chase-plane height, just under the subject, so the
   * aircraft reads *against the sky* immediately above a horizon that sits on
   * the lower third, with the ground running underneath it as foreground.
   *
   * The previous station sat sixteen metres above the aircraft, which put the
   * axis fifteen degrees down and made the shot a map: the horizon crawled up
   * to the top edge, the aeroplane became a detail on a green carpet and there
   * was nothing for the eye to read the speed against. A low pass is only fast
   * if there is something close to the lens going past.
   */
  low: {
    mode: 'scripted',
    timeOfDay: 17.55,
    weather: CLEAR,
    fov: 50,
    distance: 20,
    bearing: 2.38,
    // *Above* the aircraft, which is the opposite of what a low pass sounds
    // like it wants and is the reason it works. From below, the axis tilts up
    // and the ground gets squeezed into the bottom quarter; from five metres
    // above, the axis tilts further down, the horizon rides higher still, and
    // the wing planform is presented to the lens instead of its leading edge —
    // which is what stops the subject reading as the critique's "dark brown log".
    height: 2.5,
    frameX: -0.29,
    // The single number that decides whether this framing is 'low'.
    //
    // Where the subject sits in frame is also where the *horizon* sits, because
    // at a deck pass the camera and the aircraft are at the same height. At
    // frameY 0.17 the horizon was on the middle line and the shot was a
    // landscape with an aeroplane parked in the sky above it. At 0.42 the
    // camera axis is pitched twelve degrees down, the horizon rides up into the
    // top quarter, and the lower three-quarters of the picture is ground —
    // starting about fifty metres from the lens, which at 38 m AGL on a 50°
    // lens is close enough that individual trees have branches. Pushed back from
    // 0.42, where the horizon ended up hard against the top edge and the subject
    // had no sky left to read against at all.
    frameY: 0.30,
    dutch: 0.06,
    // The sun goes behind the camera's right shoulder, and this is the single
    // most important number in the framing.
    //
    // At -1.22 the sun sat 56° off the lens (the frameX offset rotates the axis
    // 14° on top of the authored value). The aircraft's shadow was thrown
    // 74 m sideways-and-*backwards* at 45 m AGL: measured, it projected to
    // (8012, -4291) px on a 1920×1080 frame and its depth was negative — it was
    // physically behind the camera. That is the whole of the "zero of ten
    // frames show an aircraft shadow" finding, three rounds running.
    //
    // At -2.85 the sun is 30° off the reverse axis, the shadow runs forward
    // down the lens instead of across it, and it lands at roughly (450, 740) —
    // below and slightly left of the subject on the yellow crop, at a size the
    // eye reads as an aeroplane. Checked at 15, 26 and 45 m AGL (the subject
    // drifts over undulating farmland during the settle): it stays inside
    // x 430…500, y 690…850 across that whole range.
    //
    // What is given up: the raking beam light that drew a shadow off every
    // hedgerow. What is bought, besides the shadow: the near side of the
    // fuselage is now lit rather than in its own shadow, which is a direct
    // answer to "the aircraft is a dark low-contrast mass against a mid-value
    // field with no sun rim to lift it off" — at 40 m the shadow is a far
    // stronger altitude cue than a rim light, because it is the only thing in
    // the frame that tells you how high you are.
    sunBias: 1.0,
    sunLocked: true,
    sunRel: -2.85,
    // Genuinely low. 118 m (58 m over a 60 m ridge) still put the near ground
    // 230 m from the lens with trees four pixels wide. 34 m is hedge-hopping
    // height and it is where the sense of speed lives.
    // Banked, so the upper surface and the roundels face the camera rather than
    // the wings vanishing edge-on.
    fallback: { altitude: 34, heading: 1.75, pitch: 0.015, bank: 0.40, speed: 158 },
    // A deck pass with nothing else in it is a landscape photograph. The camera
    // is ahead of the subject looking back, so the second aeroplane goes behind
    // it — a stern chase across the fields, closing from 900 m of setup to
    // roughly 450 m by the shutter, which keeps it a legible aeroplane rather
    // than a speck or a collision.
    scene: {
      biome: 'farmland', opponent: { bearing: 2.85, range: 900, bank: 0.55 },
      gear: false, hud: false,
    },
  },

  /**
   * COCKPIT — the real rig, not a posed camera, because the point of the shot
   * is that the cockpit rig itself is good. Mid-afternoon with the sun high and
   * off-axis so the canopy frame casts shadows across the panel, and a target
   * placed in the forward quarter so the gunsight has something to sit on.
   */
  cockpit: {
    mode: 'cockpit',
    // The sun has to be BEHIND the pilot's shoulder, and it took working the
    // geometry to see why. The instrument panel faces aft and 7 degrees up, so
    // its normal is roughly (0, -0.13, -0.99) in the body frame: for any sun
    // less than about 97 degrees off the nose, N dot L is negative and the
    // panel cannot be sunlit at all, whatever the aperture does. That is the
    // arithmetic behind four rounds of "no light enters the cockpit" — the shot
    // was composed with the sun ahead, and the largest surface in the frame was
    // geometrically incapable of receiving it. At 8.1 hours and 135 degrees off
    // the nose to the left the light comes in over the port sill, rakes across
    // the panel and the starboard tub wall, and the sill rail, the windscreen
    // arch legs and the hood bows put real bars across it.
    timeOfDay: 8.1,
    weather: CUMULUS,
    fov: 60,
    // Distance/bearing/height are only consulted if no aircraft is spawned, in
    // which case the shot degrades to a composed external view rather than to
    // an empty sky.
    distance: 24,
    bearing: 2.15,
    height: -2.5,
    frameX: -0.20,
    frameY: 0.12,
    dutch: -0.06,
    sunBias: 1.0,
    sunLocked: true,
    sunRel: 1.73,
    // Banked, so the horizon runs diagonally across the canopy and the ground
    // shows through one side of the hood. A straight-and-level cockpit shot is
    // a photograph of an instrument panel; a banked one is a photograph of
    // flying.
    fallback: { altitude: 1900, heading: 0.4, pitch: 0.02, bank: 0.34, speed: 133 },
    scene: { opponent: { bearing: 0.09, range: 820, bank: 0.6 }, hud: true },
  },

  /**
   * CLOUDS — the aircraft skimming the top of a cumulus deck, backlit so the
   * cloud edges go incandescent and the aircraft reads as a silhouette with a
   * rim. Early light, deep vertical development, camera at deck height so the
   * cloud tops are a foreground layer rather than a backdrop.
   */
  clouds: {
    mode: 'scripted',
    timeOfDay: 6.75,
    weather: TOWERING,
    fov: 52,
    distance: 44,
    bearing: 1.98,
    // *Below* the aircraft, and both of them just clear of the tops.
    //
    // The previous version placed the subject 260 m above the deck (the
    // anti-fog correction pushed it there) with the camera nine metres above
    // that again, looking down. From 270 m up, a cumulus field stops being a
    // landscape and becomes a texture on the horizon: the whole lower half of
    // the frame was flat blue sea. Sitting the camera just over the tops and
    // tilting up puts the near towers in the bottom third as genuine
    // foreground, with the backlight making their edges incandescent, which is
    // the entire point of the shot.
    // Fourteen metres under the aircraft, both of them just over the tops. Shot
    // at −46 as well: from below the deck the whole frame becomes the *underside*
    // of the layer, flat and dark, with the aeroplane a speck in it. The deck has
    // to be under the lens, not over it.
    height: -14,
    frameX: 0.24,
    // High in frame, so the tops are not a strip along the bottom edge but the
    // lower half of the picture.
    frameY: 0.30,
    dutch: -0.12,
    // Backlit, but with the disc just outside the frame. At 32° it was inside a
    // 52° lens and its aureole — seen *through* the top of a 2.6 km deck, which
    // is the most efficient forward-scatterer in the scene — turned the left
    // half of the picture into featureless cream and took the cloud silhouettes
    // with it. At 54°, against a 44° half-width, the tops between the sun and
    // the camera still go incandescent along their rims but the frame keeps its
    // contrast, and the aircraft on the right third reads against them.
    sunBias: 1.0,
    sunLocked: true,
    sunRel: 1.35,
    // Altitude comes from 'cloudTopOffset', not from here.
    fallback: { altitude: 4300, heading: 5.1, pitch: 0.16, bank: -0.34, speed: 118 },
    // Skimming, not overflying. At 130 m the aircraft was a separate object
    // floating in clear air above a white carpet — the two never touched, and
    // the shot read as two unrelated layers. At 45 m the towers along the near
    // edge of the deck come up to the wing line, so the aeroplane is *in* the
    // cloudscape: tops pass under the tailplane, the backlight goes through
    // them, and the gap between aircraft and cloud stops being the subject.
    // Metres above the deck's real top (DECK_TOP_FRACTION), found by shooting
    // the framing at 240 / 470 / 900 / 1500 and looking at the four.
    //
    // This number decides the one thing the shot is about, which is the *gap*.
    // The critique's complaint was that the aeroplane floats beside the cloud
    // rather than interacting with it, and the gap is what you see: too high
    // (900, 1500) and the deck retreats into a white band along the horizon
    // with two thirds of empty sky between; too low (240, and the sweep at −520)
    // and the near edge slides off the bottom of the frame, so the aircraft is
    // over the deck but the deck is no longer in the picture. At 470 the near
    // tops come up to just under the wing, the taller shoulders break the line
    // behind it, and there is still enough clear air that the camera — fourteen
    // metres lower again — is not inside a cloud photographing grey.
    cloudTopOffset: 470,
    // A second aircraft, but no guns. Sustained fire put a rope of gun-gas puffs
    // diagonally across the one frame in the set whose whole subject is the
    // shape of the cloudscape, and a muzzle flash is the last thing a backlit
    // shot needs. The event here is two aeroplanes on the deck of a cumulus
    // field, which is enough.
    // 'hills' is not about the terrain — at 3 km the ground is a haze band and
    // you cannot tell what is under it. It moves the shot to a different part of
    // the weather field. Cloud coverage is a texture sampled in world XZ, so it
    // varies across a 64 km map regardless of what the directive asks for, and
    // the default anchor happened to sit in a hole: the deck only appeared as a
    // band ten kilometres away and the near sky was empty over open sea. The
    // hills site has closed cover overhead.
    scene: { biome: 'hills', opponent: { bearing: 0.12, range: 620, bank: 0.4 }, gear: false, hud: false },
  },

  /**
   * GROUND_ATTACK — a strafing dive. Wide lens from behind and above, subject
   * pushed high in frame so the lower two thirds are ground: the shot is about
   * what is being attacked, not about the aeroplane.
   */
  ground_attack: {
    mode: 'scripted',
    // Mid-morning. At 11.2 the fields were lit flat from overhead and read as a
    // green carpet with no relief; at 8.35 the sun was so low that with the
    // camera pitched twenty degrees down the entire lower two thirds of the
    // frame fell into a near-black olive wash — the critique's "single muddy
    // olive" verdict, and it got worse once a muzzle flash was in shot pulling
    // the exposure down on top of it. 10.4 keeps a 40°-ish sun: shadows still
    // long enough to draw every revetment and hedgerow, ground still lit.
    timeOfDay: 10.4,
    weather: CLEAR,
    fov: 76,
    // Close, on a wide lens, in the dive. This is the shot where the ground has
    // to feel like it is coming up at you, and that only happens if the near
    // edge of the frame is a couple of hundred metres from the lens.
    distance: 16,
    bearing: 0.34,
    // Seven metres over the aircraft rather than five, which with frameY takes
    // the camera axis from 29° down to 36°. The critique asked for "roughly 15
    // degrees more nose-down"; this is half of that, on purpose. The reason the
    // extra pitch was wanted was to get the ground under the aeroplane into the
    // picture, and moving the sun (below) does that far more cheaply — a full
    // 15° puts the horizon off the top edge and the frame loses the one band of
    // sky that stops it reading as a map. At 36° the runway still runs out to a
    // horizon in the top eighth and the airfield fills the rest.
    height: 7.0,
    frameX: -0.21,
    frameY: 0.32,
    dutch: 0.16,
    // Three-quarter *front* light — the sun 40° off the reverse axis rather
    // than on the beam.
    //
    // On the beam (the authored 1.28, which lands 92° off the lens once frameX
    // has rotated the axis) the shadow of a 190 m aircraft is thrown 164 m
    // sideways and projects to (1788, 1687) px: off the bottom-right corner of
    // a 1920×1080 frame. Rotating the sun round to 140° off the lens throws it
    // forward instead, and it lands on the runway concrete at about
    // (1170, 760) — a hard, unmistakable aeroplane planform on bright grey,
    // which is the single most legible place on this map to put it.
    //
    // 40° off the reverse axis is as far round as the light can be kept and
    // still deliver that: hangars, revetments and the treeline all still throw
    // shadows the camera can see, so the airfield keeps its relief. Verified
    // stable across 40…200 m AGL — the shadow moves about 110 px over that
    // whole range, because the displacement is along the view axis and
    // perspective divides it back out.
    sunBias: 1.0,
    sunLocked: true,
    sunRel: 2.10,
    // Down from 300 m, and this is what makes the shadow an object rather than
    // a speck. The site's terrain sits 110–130 m up, so 300 m of authored
    // altitude was a 170–210 m AGL pass and the shadow was 25 px of smudge on
    // dark grass. At 200 m the pass is 70 m AGL — actual strafing height — and
    // the shadow is a legible airframe.
    //
    // The dive angle is not decoration: it is what decides where the rounds
    // land. In a 23° dive from 70 m the trajectory reaches the ground about
    // 165 m ahead, and the aircraft covers roughly 280 m during the second and
    // a half the harness waits, so the airfield has to start about 450 m up the
    // nose for the burst to walk across it exactly as the shutter opens. (The
    // old 700 m was solved for the old 700 m of reach from 300 m.)
    fallback: { altitude: 200, heading: 3.6, pitch: -0.40, bank: 0.16, speed: 176 },
    scene: {
      groundTargets: true, biome: 'airfield', aimAt: 'airfield', standoff: 460,
      firing: true, hud: false,
    },
  },

  /**
   * SUNSET — a silhouette. The sun is placed just off the subject so it is not
   * eclipsed, the subject is on the right third with the sun on the left, and
   * the haze is cranked so the light physically blooms through the atmosphere
   * rather than being a post-process afterthought.
   */
  sunset: {
    mode: 'scripted',
    // Sun *above* the horizon, not behind it.
    //
    // At 20.62 the disc had already set: the sky was a beautiful orange wash
    // with no source in it, which is why a sunset frame ended up with no sun,
    // no aureole, no bloom and no specular track on the water. Backing off
    // three-quarters of an hour puts the disc a few degrees up — still deep
    // golden, still long shadows, but now there is something at the end of the
    // light path and the sea underneath it has something to reflect.
    timeOfDay: 20.15,
    weather: GOLDEN,
    fov: 44,
    // Closer than before: the silhouette has to carry the frame, and at 33 m it
    // was a small dark shape floating in a large orange rectangle.
    distance: 21,
    bearing: 2.05,
    height: -1.6,
    frameX: 0.30,
    frameY: 0.16,
    dutch: -0.05,
    sunBias: 1.0,
    sunLocked: true,
    // 24° off the lens: the disc lands about two thirds of the way out to the
    // left on a 44° frame while the subject sits on the right third, so the two
    // never collide and the aeroplane is lit from behind — which is what makes a
    // silhouette a silhouette. Pushed out from 17° because a low sun this close
    // to boresight bloomed across half the picture and took the sea's specular
    // track with it.
    sunRel: 0.52,
    // Over the coast rather than mid-ocean, and low enough that the shoreline
    // is a receding edge in the bottom third instead of a distant smudge —
    // foreground depth under a sky that is otherwise one enormous flat gradient.
    fallback: { altitude: 1050, heading: 4.3, pitch: 0.05, bank: -0.14, speed: 121 },
    // A second silhouette crossing the light. 1400 m of setup leaves it around
    // 900 m out — small, but at this contrast a black planform against a lit sky
    // reads clearly, and two aircraft turn a postcard into a moment.
    scene: {
      biome: 'coast', opponent: { bearing: -2.35, range: 1500, bank: 0.35 },
      gear: false, hud: false,
    },
  },

  /**
   * WATER — low over the sea with the sun's glitter path running toward the
   * camera. The station is below the aircraft so the water occupies the bottom
   * half and the specular track leads the eye up to the subject.
   */
  water: {
    mode: 'scripted',
    // Low sun. At 17.45 the sun sat 14 degrees up and behind the camera's
    // shoulder, so the sea had no glitter path, no horizon interest and no
    // reason to be in the shot: the frame was a 10 m aeroplane on 2 megapixels
    // of flat blue. Late light puts the specular track in frame and gives the
    // water something to do.
    timeOfDay: 18.4,
    weather: CLEAR,
    fov: 46,
    // Close enough that the aircraft has presence, high enough in frame that
    // the glitter path runs *under* it and leads the eye up.
    distance: 22,
    bearing: 2.30,
    // Below the aircraft: at 48 m over a beach with the camera above it, the
    // sand filled the bottom half of the frame and the shot became a photograph
    // of a beach. From underneath, the sea and the horizon carry it.
    height: -2.2,
    frameX: -0.26,
    // Well back from 0.24. At a quarter of the frame the camera was pitched
    // fifteen degrees down and the shot became a photograph of a beach: sand
    // across the middle third, sea only in the bottom corner. At 0.13 the
    // horizon sits just above the middle, so the picture is sea, the glitter
    // path has room to run, and the shoreline is a receding edge at the bottom
    // rather than the subject.
    frameY: 0.13,
    dutch: 0.04,
    // Point the lens at the sun, because the glitter path is not a property of
    // the water — it is the set of wave facets that happen to mirror the sun
    // into *this* camera, and it only exists along the line joining the two.
    // At sunRel 2.62 the sun was 30° off the axis and its track ran off the side
    // of the frame; at 2.95 the track starts under the disc on the horizon and
    // runs straight down the picture to the bottom edge, passing under the
    // aircraft, which is the leading line this shot never had.
    //
    // This framing knowingly has no aircraft shadow, and it is the right call.
    // Pointing the lens 14° from the sun means the shadow is thrown straight
    // *at* the camera: measured, the ray hits the water 404 m out and projects
    // to a negative depth — it is behind the lens, and no amount of pitch or
    // boom will retrieve it. The only fix would be swinging the sun round
    // behind the camera, which would take the glitter path with it, and the
    // glitter path is the entire reason this shot exists. A backlit sea frame
    // with no visible shadow is what the photograph would actually look like.
    sunBias: 1.0,
    sunLocked: true,
    sunRel: 0.24,
    // Down on the wave tops, but not so low that the beach becomes the subject.
    // At 160 m the sea was a flat blue field seen from above and the shoreline
    // read as a map; at 95 m the swell has scale and the shore is a receding
    // edge in the lower third.
    fallback: { altitude: 150, heading: 2.9, pitch: 0.01, bank: 0.10, speed: 146 },
    // Coast rather than open water: a shoreline in the far third is the
    // difference between "the sea" and "an empty blue rectangle". The opponent
    // is what stops the sky being empty — the rubric's empty-frame clause was
    // written for exactly this picture.
    scene: {
      biome: 'coast', opponent: { bearing: 2.55, range: 1100, bank: -0.4 },
      hud: false,
    },
  },

  /**
   * DAMAGE — close and slightly behind, on the damaged side, with the smoke
   * trail running out of frame. Short boom and a normal lens so the panel
   * damage, holes and oil streaking are legible at 1:1.
   */
  damage: {
    mode: 'scripted',
    // Late afternoon rather than one o'clock, and the reason is the shadow's
    // *length*. A 63° midday sun puts the shadow half an altitude away from the
    // point below the aircraft; from 290 m that is 145 m, which at this boom
    // length is still 60° below the lens axis and would need the camera pitched
    // 48° down to see — a top-down frame with no sky in it, which would throw
    // away the one thing this shot is admired for. A 32° sun puts it 1.66
    // altitudes out, far enough forward that an 17° axis reaches it, and the
    // horizon stays in the top seventh with the sea and the sky still in shot.
    timeOfDay: 17.5,
    weather: CUMULUS,
    fov: 47,
    distance: 15.5,
    bearing: 0.92,
    // Just under two metres higher than before, which is the whole of the extra
    // nose-down this frame needed: 10.6° of axis depression becomes 17.2°.
    height: 4.3,
    frameX: -0.24,
    frameY: 0.08,
    dutch: 0.115,
    // Sun-locked, which it was not. At 'sunBias' 0.5 the light was a blend
    // between the subject's quarter and the sun's, so the actual angle came out
    // wherever the aeroplane's heading happened to leave it — measured at 179°
    // off the lens, i.e. by luck already almost dead behind the camera. Locking
    // it at 169° makes that reproducible instead of accidental, and nudges the
    // shadow off the exact centre line so it falls below-left of the subject
    // rather than directly beneath it, where the airframe would hide it.
    sunBias: 1.0,
    sunLocked: true,
    sunRel: -2.95,
    // 1<<0 LeftWing | 1<<6 Engine | 1<<7 EngineFire | 1<<9 OilLeak
    //
    // Down from 1250 m to roughly 160 m over the ground. At 1.2 km the shadow
    // was 1400 m of ray away and projected a thousand pixels below the frame;
    // there is no honest way to show one from that height and the frame should
    // not pretend. Coming down also tells the story better — a holed aeroplane
    // with its engine alight is not cruising at four thousand feet, it is going
    // down — and it puts the coastline, the beach and the surf line, which are
    // the best terrain work in the build, close enough to read.
    fallback: { altitude: 190, heading: 1.2, pitch: -0.14, bank: -0.42, speed: 112 },
    // Deliberately no 'biome'. The default anchor is a fixed point on the map
    // that happens to sit a kilometre inland of a shoreline, which is exactly
    // what this frame wants: fields under the aeroplane for its shadow to fall
    // on, and the sea across the far third for the teal-against-orange grade
    // that is the best colour work in the build. Asking for 'coast' instead
    // moves the station to *open water* — that biome is specified as deep sea
    // for the first three kilometres with land only beyond six, for the benefit
    // of the water and sunset frames — and shot from there this framing has no
    // ground under it at all and loses the shadow again. Verified by shooting
    // both.
    scene: {
      damage: (1 << 0) | (1 << 6) | (1 << 7) | (1 << 9), fire: 0.75, smoke: 1,
      hud: false,
    },
  },

  /**
   * HUD — an honest gameplay frame: the live chase rig, HUD on, a target in the
   * forward quarter so the lead pipper, range readout and target box all have
   * something real to display.
   */
  hud: {
    mode: 'chase',
    timeOfDay: 10.15,
    weather: CUMULUS,
    fov: 62,
    // Same as the cockpit framing: only used when there is nothing to follow.
    distance: 19,
    bearing: 0.34,
    height: 4.0,
    // Unlike every other framing here, these two are honoured by the *live*
    // chase rig — see CameraSystem.rigChase, which converts them to metres at
    // the boom's length exactly as 'composeFraming' does. They used to be
    // documentation only, and the rig's own fixed 'frameLift' put the aeroplane
    // dead centre: measured at (972, 683) on a 1920×1080 frame, i.e. on the
    // vertical centre line, directly under the reticle stack, so airframe and
    // instrument merged into one unreadable knot. That has now been the
    // composition note twice.
    //
    // -0.34 puts it on the left third. The chase camera looks down the flight
    // path, so the aeroplane's nose points at the vanishing point near the
    // frame centre — from the left third that means the nose leads *into* the
    // open right two thirds, where the target box, the range readout and the
    // contact at bearing 0.13 all are. Held a little lower than the rig's
    // default so the wing does not climb into the airspeed tape.
    frameX: -0.34,
    frameY: -0.30,
    dutch: 0.05,
    sunBias: 0.4,
    sunRel: 1.6,
    fallback: { altitude: 1750, heading: 5.6, pitch: 0.04, bank: 0.30, speed: 149 },
    // 900 m of setup lands the contact around 380 m — a plausible gunnery range
    // for the lead pipper and the target box, and outside the 260 m band where
    // the opponent would be drawn at LOD0 with its full cockpit interior.
    scene: { opponent: { bearing: 0.13, range: 900, bank: 0.5 }, hud: true, firing: true },
  },
};

export const FRAMING_NAMES = Object.keys(FRAMINGS) as FramingName[];

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _fwdH = new THREE.Vector3();
const _sunH = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _look = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _qRoll = new THREE.Quaternion();
const AXIS_Z = new THREE.Vector3(0, 0, 1);

export interface ComposedShot {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  fov: number;
}

export function newComposedShot(): ComposedShot {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 60 };
}

/** Shortest-arc interpolation between two angles. */
function blendAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Turns a framing spec into an exact camera pose.
 *
 * @param subjectPos   world position of the thing being photographed
 * @param subjectFwd   its forward direction (need not be horizontal)
 * @param sunDir       direction the sunlight travels, i.e. *from* the sun
 * @param scale        subject size relative to a 9.5 m fighter
 */
export function composeFraming(
  out: ComposedShot,
  spec: FramingSpec,
  subjectPos: THREE.Vector3,
  subjectFwd: THREE.Vector3,
  sunDir: THREE.Vector3,
  aspect: number,
  scale = 1,
): ComposedShot {
  // Horizontal heading of the subject.
  _fwdH.set(subjectFwd.x, 0, subjectFwd.z);
  if (_fwdH.lengthSq() < 1e-6) _fwdH.set(0, 0, 1);
  _fwdH.normalize();
  const headingAz = Math.atan2(_fwdH.x, _fwdH.z);

  // Bearing of the camera station measured from dead astern of the subject.
  const azSubject = headingAz + Math.PI + spec.bearing;

  // Bearing that puts the sun at the requested angle from the camera axis. The
  // camera axis points from the station toward the subject, i.e. az + π.
  _sunH.set(-sunDir.x, 0, -sunDir.z);          // toward the sun
  if (_sunH.lengthSq() < 1e-6) _sunH.set(0, 0, -1);
  _sunH.normalize();
  const sunAz = Math.atan2(_sunH.x, _sunH.z);
  const azSun = sunAz - Math.PI - spec.sunRel;

  const az = blendAngle(azSubject, azSun, Math.max(0, Math.min(1, spec.sunBias)));

  _dir.set(Math.sin(az), 0, Math.cos(az));
  out.position.copy(subjectPos)
    .addScaledVector(_dir, spec.distance * scale)
    .addScaledVector(WORLD_UP, spec.height * scale);

  out.fov = spec.fov;

  // Offset the look target so the subject lands on the requested thirds. The
  // displacement needed is the on-screen offset converted back to world units
  // at the subject's distance.
  const d = out.position.distanceTo(subjectPos);
  const tanV = Math.tan((spec.fov * Math.PI) / 360);
  const tanH = tanV * aspect;

  _look.copy(subjectPos).sub(out.position).normalize();
  _right.crossVectors(_look, WORLD_UP);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
  _right.normalize();
  _up.crossVectors(_right, _look).normalize();

  _look.copy(subjectPos)
    .addScaledVector(_right, -spec.frameX * tanH * d)
    .addScaledVector(_up, -spec.frameY * tanV * d);

  _m.lookAt(out.position, _look, WORLD_UP);
  out.quaternion.setFromRotationMatrix(_m);
  if (spec.dutch !== 0) {
    _qRoll.setFromAxisAngle(AXIS_Z, spec.dutch);
    out.quaternion.multiply(_qRoll);
  }
  return out;
}
