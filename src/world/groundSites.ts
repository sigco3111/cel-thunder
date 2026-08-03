import { Rng } from '../shared/math';
import { COARSE_N, COARSE_STEP, MAP_HALF, SEA_LEVEL, type Heightfield } from './heightfield';

/**
 * Where every attackable thing on the ground stands.
 *
 * This is the *siting* half of 'GroundTargets.ts', pulled out into a module
 * with no three.js in it so the authoritative server can call the same code
 * rather than mirroring it.
 *
 * It used to be mirrored. 'GroundWar.ts' carried a hand-copied reproduction of
 * the flak scatterer's first two passes — same seed, same generator, same draw
 * order — with a comment warning that the two would silently drift apart if
 * either changed. That mirror covered 21 gun positions; the client meanwhile
 * built 76 targets from the same heightfield, of which the server knew nothing
 * at all, so trucks, wagons, the factory, the rail yard and the bridge were
 * scenery a player could destroy locally with no effect on the match. One
 * function, called by both halves, removes both problems: the guns cannot drift
 * and the other fifty-odd targets are real.
 *
 * ## Why the RNG draw order is load-bearing
 *
 * Every position here comes out of a single 'Rng' seeded from the map seed, and
 * a placement that is rejected still consumes the draws it made. So the *order*
 * and *count* of draws is part of the layout, not an implementation detail: the
 * renderer consumes the returned records instead of re-deriving anything, which
 * is what makes drift impossible rather than merely unlikely.
 *
 * ## Why the result is memoised
 *
 * Siting the factory and the rail yard *grades* the heightfield under their
 * footprints ('flattenSite'), and 'clearOfWorks' below tests against exactly
 * that grading. Running the pass twice on one process-wide heightfield would
 * therefore produce a different layout the second time — which is what a server
 * hosting a second room would have done. One result per seed, for the life of
 * the process.
 */

export type TargetKind = 'aa' | 'truck' | 'bridge' | 'factory' | 'railyard' | 'depot';

/** One instanced, individually destroyable unit. */
export interface GroundUnitSite {
  kind: TargetKind;
  /** Instanced render batch this unit belongs to. */
  batch: 'aaGuns' | 'trucks' | 'lightArmour' | 'wagons';
  /** 0 = allies, 1 = axis, 2 = neutral/contested (the client draws these grey). */
  team: number;
  x: number; y: number; z: number;
  yaw: number;
  radius: number;
  hp: number;
  /** AA only: sandbag ring yaw, and the gun class 0 = light, 1 = medium, 2 = heavy. */
  pitYaw: number;
  aaClass: number;
  /**
   * AA only: which side actually owns the position.
   *
   * The client draws contested-belt guns neutral because it has no notion of a
   * front line. The server does — a belt gun belongs to whichever field it is
   * nearer — and that is what makes the middle of the map contested airspace
   * rather than a hazard that shoots at everybody.
   */
  owner: number;
}

/** A merged, non-instanced installation: the factory, the yard, the bridge. */
export interface StaticSite {
  kind: TargetKind;
  x: number; y: number; z: number;
  yaw: number;
  radius: number;
  hp: number;
  /** Extra draws the geometry builder needs, pre-rolled to fix the RNG order. */
  extra: number[];
}

export interface RiverSpan {
  cx: number; cz: number;
  /** Direction across the river (unit). */
  dx: number; dz: number;
  half: number;
  deck: number;
}

export interface GroundSiting {
  units: GroundUnitSite[];
  factory: StaticSite | null;
  railyard: StaticSite | null;
  /** Rolling stock on the yard's sidings, in placement order. */
  wagons: GroundUnitSite[];
  bridge: (StaticSite & { span: RiverSpan }) | null;
}

// ---------------------------------------------------------------------------
// Damage tables
// ---------------------------------------------------------------------------

/**
 * Structural strength per AA class, in the same hit-point currency airframes
 * use. These live here rather than in 'GroundWar.ts' so the client's target
 * record and the server's emplacement cannot disagree about how much punishment
 * the same gun pit takes.
 */
export const AA_HP: Record<number, number> = { 0: 190, 1: 260, 2: 340 };
/** Hit radius per class — a quad-20 pit is small, an 88 in its revetment is not. */
export const AA_RADIUS: Record<number, number> = { 0: 6.5, 1: 7.5, 2: 9.0 };

/**
 * Class for a gun by its position in the layout. A full aerodrome ring is two
 * heavy 88s for altitude denial, four 40 mm covering the middle band and two
 * light quads for anyone who comes in on the deck — so an attacker is under
 * fire from the moment they are inside nine kilometres, and under *aimed* fire
 * the lower they go. The contested belt is light and medium only: a lone 88 in
 * open country is a curiosity, not a defence.
 */
export function aaClassFor(slot: number, isRing: boolean): number {
  if (!isRing) return slot % 3 === 0 ? 1 : 0;
  if (slot % 4 === 0) return 2;
  if (slot % 2 === 1) return 1;
  return 0;
}

// ---------------------------------------------------------------------------

const cache = new Map<number, GroundSiting>();

export interface SiteCentre { x: number; z: number }

/** Sites everything, once per (seed, heightfield). */
export function groundSiting(
  hf: Heightfield, seed: number, centres: SiteCentre[],
): GroundSiting {
  const key = (seed >>> 0) ^ (hf.seed >>> 0);
  const hit = cache.get(key);
  if (hit) return hit;
  const built = site(hf, seed, centres);
  cache.set(key, built);
  return built;
}

/** Drops the memoised layouts. Test-only; the game never changes seed in place. */
export function clearGroundSiting(): void { cache.clear(); }

function site(hf: Heightfield, seed: number, centres: SiteCentre[]): GroundSiting {
  const rng = new Rng((seed ^ 0x517cc1b7) >>> 0 || 1);
  const units: GroundUnitSite[] = [];

  // 'padT() >= 1.6' is the same guard the vegetation scatterer uses. Without it
  // the r = 700..1500 m annulus overlaps the 990 x 480 m flattened pad and the
  // taxiway/apron block, and because the pad is dead flat the slope test passes
  // cleanly — so an 88 flush on the tarmac at the runway threshold was not an
  // unlucky roll, it was the expected outcome for several guns per map.
  const clearOfWorks = (x: number, z: number): boolean =>
    hf.padT(x, z) >= 1.6 && hf.siteT(x, z) >= 1.25;

  /** Whichever team's field this position is nearer. */
  const nearestTeam = (x: number, z: number): number => {
    let team = 0, best = Infinity;
    for (let t = 0; t < centres.length; t++) {
      const d = Math.hypot(x - centres[t].x, z - centres[t].z);
      if (d < best) { best = d; team = t; }
    }
    return team;
  };

  // --- flak: a ring around each aerodrome ----------------------------------
  for (let team = 0; team < centres.length; team++) {
    const c = centres[team];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const r = rng.range(700, 1500);
      const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
      if (hf.heightAt(x, z) < SEA_LEVEL + 3 || hf.slopeAt(x, z) > 0.30) continue;
      if (!clearOfWorks(x, z)) continue;
      const cls = aaClassFor(i, true);
      units.push({
        kind: 'aa', batch: 'aaGuns', team,
        x, y: hf.heightAt(x, z), z, yaw: a + Math.PI,
        radius: AA_RADIUS[cls], hp: AA_HP[cls],
        pitYaw: a + rng.range(-0.4, 0.4), aaClass: cls, owner: team,
      });
    }
  }

  // --- flak: the contested belt down the middle ----------------------------
  const mid = {
    x: (centres[0].x + centres[1].x) * 0.5,
    z: (centres[0].z + centres[1].z) * 0.5,
  };
  for (let i = 0; i < 14; i++) {
    const x = mid.x + rng.range(-9000, 9000);
    const z = mid.z + rng.range(-9000, 9000);
    if (hf.heightAt(x, z) < SEA_LEVEL + 4 || hf.slopeAt(x, z) > 0.28) continue;
    if (!clearOfWorks(x, z)) continue;
    const y = hf.heightAt(x, z);
    const cls = aaClassFor(i, false);
    const yaw = rng.range(0, 6.28);
    const pitYaw = rng.range(0, 6.28);
    units.push({
      kind: 'aa', batch: 'aaGuns', team: 2,
      x, y, z, yaw, radius: AA_RADIUS[cls], hp: AA_HP[cls],
      pitYaw, aaClass: cls, owner: nearestTeam(x, z),
    });
  }

  // --- truck convoy on the road between the two fields ---------------------
  // The curve here is the *same* one the terrain shader paints (see
  // 'roadDistance' in terrainMaterial.ts), so the column drives on the road
  // surface rather than through standing wheat.
  {
    const ax = centres[0].x, az = centres[0].z;
    const bx = centres[1].x, bz = centres[1].z;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    const roadOff = (t: number) => Math.sin(t * 9.1) * 420 + Math.sin(t * 3.3) * 900;
    let placed = 0;
    for (let i = 0; i < 90 && placed < 26; i++) {
      const t = 0.22 + (i / 90) * 0.56;
      const off = roadOff(t);
      // Tangent of the wandered curve, in world units per unit t.
      const dOff = (roadOff(t + 1e-3) - roadOff(t - 1e-3)) / 2e-3;
      const tanX = dx + nx * dOff, tanZ = dz + nz * dOff;
      const lane = rng.range(-3.0, 3.0);
      const x = ax + dx * t + nx * (off + lane);
      const z = az + dz * t + nz * (off + lane);
      const y = hf.heightAt(x, z);
      if (y < SEA_LEVEL + 4 || hf.slopeAt(x, z) > 0.22) continue;
      if (!clearOfWorks(x, z)) continue;
      const yaw = Math.atan2(tanX, tanZ) + rng.range(-0.05, 0.05);
      units.push({
        kind: 'truck', batch: 'trucks', team: 2, x, y, z, yaw,
        radius: 4.5, hp: 90, pitYaw: 0, aaClass: -1, owner: nearestTeam(x, z),
      });
      placed++;
      if (placed % 5 === 0) {
        // Armour pulled off onto the verge, not driving abreast in the field.
        const ox = x + nx * 8.5, oz = z + nz * 8.5;
        units.push({
          kind: 'truck', batch: 'lightArmour', team: 2,
          x: ox, y: hf.heightAt(ox, oz), z: oz, yaw,
          radius: 4.0, hp: 150, pitYaw: 0, aaClass: -1, owner: nearestTeam(ox, oz),
        });
      }
    }
  }

  // --- factory complex -----------------------------------------------------
  let factory: StaticSite | null = null;
  {
    const s = findFlatSite(hf, rng, mid.x, mid.z, 12000, 60, 500, 0.10);
    if (s) {
      // Grade the ground to the footprint the geometry actually occupies (the
      // apron is 190 x 130 m and the perimeter wall reaches 95 m), so the slab
      // corners are neither buried nor cantilevered into the air.
      const y = hf.flattenSite(s.x, s.z, 108, 78, s.yaw);
      // The two chimney heights are drawn here rather than inside the mesh
      // builder so the generator's position in the stream does not depend on
      // whether anybody is building geometry.
      const extra = [rng.range(0, 9), rng.range(0, 9)];
      factory = { kind: 'factory', x: s.x, y, z: s.z, yaw: s.yaw, radius: 95, hp: 2400, extra };
    }
  }

  // --- rail yard -----------------------------------------------------------
  let railyard: StaticSite | null = null;
  const wagons: GroundUnitSite[] = [];
  {
    const cx = mid.x + rng.range(-8000, 8000);
    const cz = mid.z + rng.range(-8000, 8000);
    const s = findFlatSite(hf, rng, cx, cz, 11000, 30, 420, 0.07);
    if (s) {
      // 218 m of rail cannot follow a hillside: grade the whole yard.
      const y = hf.flattenSite(s.x, s.z, 118, 42, s.yaw);
      railyard = { kind: 'railyard', x: s.x, y, z: s.z, yaw: s.yaw, radius: 110, hp: 1500, extra: [] };
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      for (let track = -1; track <= 1; track++) {
        for (let k = 0; k < 7; k++) {
          const a = -70 + k * 21 + track * 6;
          const b = track * 9;
          const x = s.x + a * sn + b * c;
          const z = s.z + a * c - b * sn;
          wagons.push({
            kind: 'railyard', batch: 'wagons', team: 2, x, y, z, yaw: s.yaw,
            radius: 6, hp: 140, pitYaw: 0, aaClass: -1, owner: nearestTeam(x, z),
          });
        }
      }
    }
  }

  // --- bridge --------------------------------------------------------------
  let bridge: (StaticSite & { span: RiverSpan }) | null = null;
  {
    const span = findRiverCrossing(hf);
    if (span) {
      bridge = {
        kind: 'bridge', x: span.cx, y: span.deck, z: span.cz, yaw: 0,
        radius: span.half + 12, hp: 1800, extra: [], span,
      };
    }
  }

  return { units, factory, railyard, wagons, bridge };
}

// ---------------------------------------------------------------------------
// Siting helpers
// ---------------------------------------------------------------------------

export function findFlatSite(
  hf: Heightfield, rng: Rng, cx: number, cz: number, searchR: number,
  minH: number, maxH: number, maxSlope: number,
): { x: number; y: number; z: number; yaw: number } | null {
  for (let i = 0; i < 400; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * searchR;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const y = hf.heightAt(x, z);
    if (y < minH || y > maxH) continue;
    let ok = true;
    for (let k = 0; k < 8 && ok; k++) {
      const ka = (k / 8) * Math.PI * 2;
      const px = x + Math.cos(ka) * 90, pz = z + Math.sin(ka) * 90;
      if (Math.abs(hf.heightAt(px, pz) - y) > 9 || hf.slopeAt(px, pz) > maxSlope) ok = false;
    }
    if (ok) return { x, y, z, yaw: rng.range(0, Math.PI * 2) };
  }
  return null;
}

/**
 * Finds a place to put the bridge: walks the drainage map for a strong reach,
 * then measures the width of the low ground perpendicular to the flow.
 */
export function findRiverCrossing(hf: Heightfield): RiverSpan | null {
  let best: RiverSpan | null = null;
  let bestScore = -Infinity;

  // Scan the drainage grid directly rather than sampling at random: the
  // flooded reach is one or two 128 m cells wide out of a 65 km map, and a
  // Monte-Carlo search finds it about once in three attempts.
  for (let j = 2; j < COARSE_N - 2; j++) {
    for (let i = 2; i < COARSE_N - 2; i++) {
      const fl = hf.flow[j * COARSE_N + i];
      if (fl < 0.44) continue;
      const x = -MAP_HALF + i * COARSE_STEP;
      const z = -MAP_HALF + j * COARSE_STEP;
      // The channel must be flooded here, else the bridge spans a dry gully.
      if (hf.heightAt(x, z) > SEA_LEVEL - 1.0) continue;

      // Channel direction from the flow gradient; cross it perpendicular.
      const e = 128;
      const gx = hf.sampleFlow(x + e, z) - hf.sampleFlow(x - e, z);
      const gz = hf.sampleFlow(x, z + e) - hf.sampleFlow(x, z - e);
      let dx = gx, dz = gz;
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) continue;
      dx /= l; dz /= l;

      // Walk out to dry land on both banks.
      let half = 0, ok = false;
      for (let sdist = 12; sdist <= 260; sdist += 12) {
        const h1 = hf.heightAt(x + dx * sdist, z + dz * sdist);
        const h2 = hf.heightAt(x - dx * sdist, z - dz * sdist);
        half = sdist;
        if (h1 > SEA_LEVEL + 2.5 && h2 > SEA_LEVEL + 2.5) { ok = true; break; }
      }
      if (!ok || half < 30) continue;

      // Favour a strong river at a narrow point — that is where engineers put
      // bridges, and it is where a bomb run has to be precise.
      const score = fl * 3 - half / 90;
      if (score > bestScore) {
        bestScore = score;
        best = { cx: x, cz: z, dx, dz, half: half + 22, deck: SEA_LEVEL + 10.5 };
      }
    }
  }
  return best;
}
