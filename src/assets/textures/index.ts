/**
 * Procedural texture generation — public surface.
 *
 * The livery generator is driven by the aircraft builder and is not usually
 * called directly; the damage and gauge atlases are shared singletons that other
 * subsystems (VFX, HUD) may want to reference.
 */

export {
  REGION, DETAIL, SWATCH, TEX_SIZE,
  GAUGE_TEX_SIZE, GAUGE_TILES, DAMAGE_TEX_SIZE, DAMAGE_TILES,
  uvOf, boxOf, inBox, swatchBox, detailBox, gaugeBox, damageBox,
  fuseUv, wingUv, htailUv, finUv,
} from './atlas';
export type { Rect, UvBox, SwatchName, GaugeName, DamageDecal, RegionName } from './atlas';

export { buildLivery } from './livery';
export type { LiveryInput, LiveryMaps } from './livery';

export { buildDamageAtlas } from './damageAtlas';
export type { DamageAtlas } from './damageAtlas';

export { buildGaugeAtlas } from './instruments';
export type { GaugeAtlas } from './instruments';

export { drawInsignia, drawTailMarking, rafRoundel, balkenkreuz, starAndBar, hinomaru, sovietStar } from './insignia';
export type { InsigniaPlace } from './insignia';

export {
  makeCanvas, makeSurface, makeTexture, ctx2d, heightToNormal,
  fbm, vnoise, worley, warpFbm, Rand,
} from './canvas2d';
export type { Ctx2D, Surface } from './canvas2d';
