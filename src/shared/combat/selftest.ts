/**
 * Combat subsystem self-test.
 *
 *   npx tsx src/shared/combat/selftest.ts
 *
 * These are physical assertions, not snapshot tests: each one states a number
 * a ballistics table or a combat report would give and checks the simulation
 * lands on it. If a constant in drag.ts or penetration.ts is retuned and these
 * still pass, the retune was defensible.
 */

import { v3, vset, vsub, vlen, vnorm, q as mkq, qFromEuler, Rng } from '../math';
import { AIRCRAFT_BY_ID, type AircraftSpec } from '../aircraft';
import { DamageBits } from '../protocol';

import { G0, airDensity, speedOfSound } from './atmosphere';
import { cdG1 } from './drag';
import {
  AmmoType, ModuleId, ProjectileKind, FuseKind,
  type CombatEnv, type CombatTarget, type HitResult,
} from './types';
import {
  buildAircraftProxy, createHistoryBuffer, pushHistory, sweepTarget, beginSweepBatch,
  resolveTargetTransform,
} from './proxy';
import { computePenetration, penetrationCapability } from './penetration';
import {
  ProjectilePool, createProjectile, stepProjectiles, ballisticSolution, solveLead,
} from './ballistics';
import {
  createDamageState, applyDamage, stepDamage, computeDamageEffects, healthFraction, killReason,
} from './damage';
import {
  bombSpecFromKg, dropBomb, predictBombImpact, defaultRocketSpec, launchRocket, detonateAt,
} from './ordnance';
import { AA_LIGHT, AA_HEAVY, createAaGun, stepAaGuns } from './aa';

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  [32mPASS[0m ${name}${detail ? `  ${detail}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  [31mFAIL[0m ${name}  ${detail}`); }
}

function inRange(name: string, v: number, lo: number, hi: number, unit = ''): void {
  check(name, v >= lo && v <= hi, `${v.toFixed(4)}${unit} (expected ${lo}..${hi}${unit})`);
}

function section(title: string): void {
  console.log(`\n[1m${title}[0m`);
}

// ---------------------------------------------------------------------------
// Shared test environment
// ---------------------------------------------------------------------------

function makeEnv(targets: CombatTarget[], groundY = -1e6): CombatEnv {
  return {
    time: 0,
    queryTargets: (_p0, _p1, _pad, out) => { for (const t of targets) out.push(t); },
    terrainHeight: () => groundY,
    rng: new Rng(12345),
  };
}

/** A stationary target aircraft at 'pos' with the given yaw. */
function makeTarget(
  id: number, specId: string, pos: { x: number; y: number; z: number }, yaw = 0, team = 1,
): CombatTarget {
  const spec = AIRCRAFT_BY_ID[specId];
  const q = mkq();
  qFromEuler(0, yaw, 0, q);
  const hist = createHistoryBuffer(64);
  const t: CombatTarget = {
    id, team, ownerId: id, alive: true,
    proxy: buildAircraftProxy(spec),
    p: v3(pos.x, pos.y, pos.z),
    q,
    v: v3(0, 0, 0),
    history: hist,
  };
  for (let i = 0; i < 20; i++) pushHistory(hist, i * 0.05, t.p, t.q);
  return t;
}

// ---------------------------------------------------------------------------
// 1. Atmosphere and drag sanity
// ---------------------------------------------------------------------------

section('1. Atmosphere and drag function');

inRange('sea-level density', airDensity(0), 1.224, 1.226, ' kg/m^3');
inRange('density at 6 km', airDensity(6000), 0.655, 0.665, ' kg/m^3');
inRange('speed of sound at sea level', speedOfSound(0), 340, 341, ' m/s');
inRange('speed of sound at 6 km', speedOfSound(6000), 315, 317, ' m/s');
// The transonic drag rise is the whole reason for using a drag *function*.
check('G1 Cd more than triples through transonic',
  cdG1(1.3) / cdG1(0.5) > 3.0,
  `Cd(0.5)=${cdG1(0.5).toFixed(3)} Cd(1.3)=${cdG1(1.3).toFixed(3)}`);
check('G1 Cd peaks between Mach 1.2 and 1.5',
  cdG1(1.35) > cdG1(1.0) && cdG1(1.35) > cdG1(2.0));

// ---------------------------------------------------------------------------
// 2. Bullet drop over 500 m  (REQUIRED TEST)
// ---------------------------------------------------------------------------

section('2. Bullet drop over 500 m');

// .50 BMG M2 AP: 46 g at 887 m/s from a P-51's M2 Browning. Published data:
// ~660-700 m/s remaining at 500 m, ~0.65 s time of flight, ~2 m of drop from a
// horizontal bore.
const sol = ballisticSolution(AmmoType.AP, 12.7, 0.046, 887, 500, 0);
inRange('.50 BMG time of flight to 500 m', sol.tof, 0.58, 0.72, ' s');
inRange('.50 BMG remaining velocity at 500 m', sol.impactSpeed, 600, 730, ' m/s');
inRange('.50 BMG drop at 500 m', sol.drop, 1.75, 2.35, ' m');

// Cross-check against the closed form. With drag acting on the (small)
// vertical velocity component the real drop is a few per cent *less* than the
// vacuum value, never more — if this ratio exceeds 1 the integrator is wrong.
const vacuumDrop = 0.5 * G0 * sol.tof * sol.tof;
inRange('drop / (½gt²) ratio', sol.drop / vacuumDrop, 0.90, 1.001, '');

// A 20 mm cannon shell is slower and blunter and must drop noticeably more.
const sol20 = ballisticSolution(AmmoType.HE, 20, 0.130, 860, 500, 0);
check('20 mm HE drops more than .50 AP at the same range',
  sol20.drop > sol.drop,
  `20mm=${sol20.drop.toFixed(2)} m vs .50=${sol.drop.toFixed(2)} m`);

// Thinner air at altitude must flatten the trajectory.
const solHigh = ballisticSolution(AmmoType.AP, 12.7, 0.046, 887, 500, 6000);
check('less drop at 6 km than at sea level',
  solHigh.drop < sol.drop && solHigh.tof < sol.tof,
  `6 km: ${solHigh.drop.toFixed(2)} m / ${solHigh.tof.toFixed(3)} s`);

// The live integrator (which sub-steps coarsely when no aircraft is nearby)
// must agree with the fine-grained offline solver. If it does not, the tracer
// stream and the gunsight will disagree with each other.
{
  const env: CombatEnv = {
    time: 0, queryTargets: () => {}, terrainHeight: () => -1e6, rng: new Rng(5),
  };
  const list: import('./types').Projectile[] = [];
  const p = createProjectile({
    origin: v3(0, 1000, 0), direction: v3(0, 0, 1), speed: 887,
    ammo: AmmoType.AP, calibre: 12.7, mass: 0.046,
    ownerId: 1, team: 0, shooterEntity: 1, time: 0, lifetime: 5,
  });
  list.push(p);
  let prevZ = 0, prevY = 1000, prevT = 0;
  while (list.length && p.p.z < 500) {
    prevZ = p.p.z; prevY = p.p.y; prevT = p.t;
    stepProjectiles(list, env, 1 / 60, () => {});
  }
  const a = (500 - prevZ) / Math.max(1e-9, p.p.z - prevZ);
  const liveDrop = 1000 - (prevY + (p.p.y - prevY) * a);
  const liveTof = prevT + (p.t - prevT) * a;
  const refDrop = ballisticSolution(AmmoType.AP, 12.7, 0.046, 887, 500, 1000).drop;
  inRange('live integrator drop matches the offline solver',
    liveDrop / refDrop, 0.98, 1.02, ' x');
  inRange('live integrator time of flight', liveTof, 0.58, 0.72, ' s');
}

// ---------------------------------------------------------------------------
// 3. Penetration calibration
// ---------------------------------------------------------------------------

section('3. Penetration');

inRange('.50 AP penetration at 810 m/s',
  penetrationCapability(AmmoType.AP, 12.7, 0.046, 810), 16, 24, ' mm');
inRange('.50 AP penetration at 660 m/s',
  penetrationCapability(AmmoType.AP, 12.7, 0.046, 660), 10, 17, ' mm');
inRange('7.92 mm AP penetration at 785 m/s',
  penetrationCapability(AmmoType.AP, 7.92, 0.0117, 785), 7, 14, ' mm');
inRange('20 mm AP penetration at 705 m/s',
  penetrationCapability(AmmoType.AP, 20, 0.117, 705), 18, 34, ' mm');
check('HE shell cannot defeat armour a solid AP round of the same calibre can',
  penetrationCapability(AmmoType.HE, 20, 0.130, 800)
  < penetrationCapability(AmmoType.AP, 20, 0.130, 800) * 0.35);

// ---------------------------------------------------------------------------
// 4. Shallow-angle ricochet off 12 mm plate  (REQUIRED TEST)
// ---------------------------------------------------------------------------

section('4. Ricochet off 12 mm plate');

const D2R = Math.PI / 180;

// 75° from the normal is a classic deflection shot: the round has to travel
// through 12/cos75 = 46 mm of line-of-sight steel and skates off instead.
const shallow = computePenetration({
  ammo: AmmoType.AP, calibre: 12.7, mass: 0.046, velocity: 800,
  armourMm: 12, cosTheta: Math.cos(75 * D2R),
});
check('shallow (75°) .50 AP hit on 12 mm ricochets',
  shallow.outcome === 'ricochet' && shallow.ricochetChance > 0.99,
  `outcome=${shallow.outcome} chance=${shallow.ricochetChance.toFixed(3)} eff=${shallow.effectiveMm.toFixed(1)} mm`);
inRange('effective thickness at 75°', shallow.effectiveMm, 25, 60, ' mm');
check('ricocheting round keeps most of its speed',
  shallow.residualVelocity > 500 && shallow.residualVelocity < 800,
  `${shallow.residualVelocity.toFixed(0)} m/s`);

// The same round, square on, must go straight through.
const square = computePenetration({
  ammo: AmmoType.AP, calibre: 12.7, mass: 0.046, velocity: 800,
  armourMm: 12, cosTheta: 1,
});
check('same round at 0° penetrates 12 mm',
  square.outcome === 'penetrate' && square.residualVelocity > 100,
  `pen=${square.penetrationMm.toFixed(1)} mm, residual=${square.residualVelocity.toFixed(0)} m/s`);

// A soft ball round should skip off at a shallower angle than hardened AP.
const ballShallow = computePenetration({
  ammo: AmmoType.Ball, calibre: 7.92, mass: 0.0117, velocity: 780,
  armourMm: 8, cosTheta: Math.cos(60 * D2R),
});
const apShallow = computePenetration({
  ammo: AmmoType.AP, calibre: 7.92, mass: 0.0117, velocity: 780,
  armourMm: 8, cosTheta: Math.cos(60 * D2R),
});
check('ball skips more readily than AP at 60°',
  ballShallow.ricochetChance > apShallow.ricochetChance,
  `ball=${ballShallow.ricochetChance.toFixed(2)} ap=${apShallow.ricochetChance.toFixed(2)}`);

// Grazing hits on thin, unarmoured structure must NOT ricochet — there is
// nothing there to skip off.
const skin = computePenetration({
  ammo: AmmoType.AP, calibre: 12.7, mass: 0.046, velocity: 800,
  armourMm: 0, cosTheta: Math.cos(80 * D2R),
});
check('no ricochet off bare skin at 80°', skin.outcome === 'penetrate');

// ---------------------------------------------------------------------------
// 5. Collision proxy and lag compensation
// ---------------------------------------------------------------------------

section('5. Collision proxy and lag compensation');

const zeroProxy = buildAircraftProxy(AIRCRAFT_BY_ID['a6m5']);
check('Zero proxy has a plausible module count',
  zeroProxy.shapes.length >= 20 && zeroProxy.shapes.length <= 40,
  `${zeroProxy.shapes.length} shapes`);
check('Zero proxy bounding radius is aircraft-sized',
  zeroProxy.boundRadius > 4 && zeroProxy.boundRadius < 12,
  `${zeroProxy.boundRadius.toFixed(2)} m`);
{
  const mods = new Set(zeroProxy.shapes.map((s) => s.module));
  const required = [
    ModuleId.Engine, ModuleId.Pilot, ModuleId.WingLeft, ModuleId.WingRight,
    ModuleId.SparLeft, ModuleId.SparRight, ModuleId.TailBoom,
    ModuleId.AileronLeft, ModuleId.Elevator, ModuleId.Rudder,
    ModuleId.CablePitch, ModuleId.CableRoll, ModuleId.CableYaw,
    ModuleId.AmmoLeft, ModuleId.AmmoRight,
  ];
  check('proxy covers every required module', required.every((m) => mods.has(m)));
}

{
  // Fire straight down the aircraft's axis from in front: the round must meet
  // the prop hub / engine before it meets the pilot.
  const tgt = makeTarget(1, 'a6m5', { x: 0, y: 1000, z: 0 });
  beginSweepBatch();
  const list: import('./proxy').ShapeHit[] = [];
  const n = sweepTarget(tgt, 0, 0, v3(0, 1000, 40), v3(0, 1000, -40), list);
  check('axial sweep finds multiple modules', n >= 4, `${n} modules`);
  const engineIdx = list.findIndex((h) => h.module === ModuleId.Engine || h.module === ModuleId.PropHub);
  const pilotIdx = list.findIndex((h) => h.module === ModuleId.Pilot);
  check('engine is struck before the pilot on a head-on pass',
    engineIdx >= 0 && pilotIdx >= 0 && engineIdx < pilotIdx,
    `engine@${engineIdx} pilot@${pilotIdx}`);
}

{
  // A thin aileron must be hit by a 900 m/s round even though a single tick
  // would move it 15 m — this is the anti-tunnelling requirement.
  const spec = AIRCRAFT_BY_ID['a6m5'];
  const aileron = buildAircraftProxy(spec).shapes.find((s) => s.module === ModuleId.AileronRight)!;
  const tgt = makeTarget(2, 'a6m5', { x: 0, y: 1000, z: 0 });
  const pool = new ProjectilePool(8);
  const env = makeEnv([tgt]);
  const list: import('./types').Projectile[] = [];
  const hitModules: ModuleId[] = [];
  const start = v3(aileron.centre.x, 1000 + aileron.centre.y, 60);
  list.push(createProjectile({
    origin: start, direction: v3(0, 0, -1), speed: 900,
    ammo: AmmoType.AP, calibre: 12.7, mass: 0.046,
    ownerId: 9, team: 0, shooterEntity: 9, time: 0, pool,
  }));
  for (let i = 0; i < 20 && list.length; i++) {
    env.time = i / 60;
    stepProjectiles(list, env, 1 / 60, (h: HitResult) => {
      if (h.targetId === 2 && h.module >= 0) hitModules.push(h.module as ModuleId);
    }, pool);
  }
  check('900 m/s round does not tunnel through a thin aileron',
    hitModules.indexOf(ModuleId.AileronRight) >= 0,
    `hit modules: ${hitModules.map((m) => ModuleId[m]).join(', ') || 'none'}`);
}

{
  // Lag compensation: the server has to test the shot against where the
  // shooter *saw* the target, not where it is now.
  //
  // The target does NOT fly in a straight line here, and that is the whole
  // point. A straight-line target makes the test unable to fail for the reason
  // that matters: with constant velocity, "interpolate the recorded history"
  // and "extrapolate backwards from the current position and velocity" give
  // exactly the same answer, so an implementation that never looks at the
  // history at all passes. The path below is a hard weave — 200 m/s of drift
  // with a 60 m, 1 Hz-ish oscillation on top — so the two disagree by tens of
  // metres, and only a real history lookup lands the round.
  //
  //   x(t) = -100 + 200·t + 60·sin(6·t)
  //
  // 'tgt.v' is set to the true instantaneous velocity throughout, so a naive
  // p − v·rewind implementation has everything it needs and still misses.
  const tgt = makeTarget(3, 'p51d', { x: 0, y: 1000, z: 0 });
  const xAt = (t: number) => -100 + 200 * t + 60 * Math.sin(6 * t);
  const vxAt = (t: number) => 200 + 360 * Math.cos(6 * t);
  const hist = tgt.history!;
  const DTH = 0.02;                       // 50 Hz position history
  hist.head = -1; hist.count = 0;
  // Fill the ring exactly once. Pushing more than it holds silently evicts the
  // oldest samples, and since the rewind then clamps to whatever is left the
  // shot quietly misses for a reason that has nothing to do with the code
  // under test — so the sample count is derived from the buffer, not guessed.
  const CAP = hist.samples.length;
  const OLDEST_T = 0;
  for (let i = 0; i < CAP; i++) {
    const t = OLDEST_T + i * DTH;
    pushHistory(hist, t, v3(xAt(t), 1000, 0), tgt.q);
  }
  const NEWEST_T = OLDEST_T + (CAP - 1) * DTH;

  const env = makeEnv([tgt]);
  const REWIND = 0.5;
  const FIRE_T = 0.5;

  // Measure the true time of flight to the target's plane.
  let tof = 0;
  {
    const probe: import('./types').Projectile[] = [];
    const pr = createProjectile({
      origin: v3(0, 1000, 300), direction: v3(0, 0, -1), speed: 880,
      ammo: AmmoType.AP, calibre: 12.7, mass: 0.046,
      ownerId: 1, team: 0, shooterEntity: 1, time: FIRE_T,
    });
    probe.push(pr);
    const noTargets: CombatEnv = {
      time: 0, queryTargets: () => {}, terrainHeight: () => -1e6, rng: new Rng(1),
    };
    while (pr.p.z > 0 && pr.t < 2) stepProjectiles(probe, noTargets, 1 / 480, () => {});
    tof = pr.t;
  }
  const impactTime = FIRE_T + tof;
  const aimX = xAt(impactTime - REWIND);

  // Guard the guard: if the path is ever flattened back into a straight line,
  // this fails and says so, rather than the suite quietly going back to
  // proving nothing.
  const naiveX = xAt(impactTime) - vxAt(impactTime) * REWIND;
  check('lag comp: the test target is genuinely manoeuvring',
    Math.abs(naiveX - aimX) > 25,
    `history ${aimX.toFixed(1)} m vs naive p−v·rewind ${naiveX.toFixed(1)} m `
    + `(${Math.abs(naiveX - aimX).toFixed(1)} m apart)`);

  const fire = (rewind: number): boolean => {
    let hit = false;
    const list: import('./types').Projectile[] = [];
    list.push(createProjectile({
      origin: v3(aimX, 1000, 300), direction: v3(0, 0, -1), speed: 880,
      ammo: AmmoType.AP, calibre: 12.7, mass: 0.046,
      ownerId: 1, team: 0, shooterEntity: 1, time: FIRE_T, rewind,
    }));
    for (let i = 0; i < 300 && list.length; i++) {
      env.time = FIRE_T + i / 480;
      vset(tgt.p, xAt(env.time), 1000, 0);
      vset(tgt.v, vxAt(env.time), 0, 0);
      stepProjectiles(list, env, 1 / 480, (h: HitResult) => {
        if (h.targetId === 3 && h.module >= 0) hit = true;
      });
    }
    return hit;
  };
  const hitComp = fire(REWIND);
  const hitNoComp = fire(0);
  check('lag compensation rewinds the target onto the shot',
    hitComp && !hitNoComp,
    `tof=${tof.toFixed(3)}s aimX=${aimX.toFixed(1)} comp=${hitComp} nocomp=${hitNoComp}`);

  // The compensation has to be *correct*, not merely generous. Rewinding by
  // the wrong amount must miss — otherwise the hit test has simply grown a
  // tolerance big enough to swallow the error.
  const wrong = [0.25, 0.4, 0.65, 1.0].map((r) => ({ r, hit: fire(r) }));
  check('lag comp: only the right rewind hits',
    wrong.every((w) => !w.hit),
    wrong.map((w) => `${w.r}s:${w.hit ? 'HIT' : 'miss'}`).join(' '));

  // Interpolation between stored samples: ask for a time deliberately between
  // two 50 Hz samples and check the answer sits on the real path.
  {
    const p = v3(), qq = mkq();
    let worst = 0;
    let n = 0;
    for (let k = 0; k < 40; k++) {
      const t = OLDEST_T + 0.031 + k * 0.017;   // never lands on a sample boundary
      if (t > NEWEST_T) break;
      resolveTargetTransform(tgt, t + REWIND, REWIND, p, qq);
      worst = Math.max(worst, Math.abs(p.x - xAt(t)));
      n++;
    }
    // The path curves between samples, so linear interpolation cannot be
    // exact; the bound is the chord error of a 60 m, 6 rad/s sine over a
    // 20 ms step — |x''|h²/8 = 60·36·0.0004/8 ≈ 0.11 m.
    check('lag comp: history interpolates between stored samples', n > 30 && worst < 0.15,
      `worst error ${worst.toFixed(3)} m over ${n} off-sample times`);
  }

  // Asking for a time older than anything retained must clamp to the oldest
  // sample, not read uninitialised slots or fall off the end of the ring.
  {
    const p = v3(), qq = mkq();
    resolveTargetTransform(tgt, 0.5, 60, p, qq);
    check('lag comp: an over-long rewind clamps to the oldest sample',
      Math.abs(p.x - xAt(OLDEST_T)) < 1e-6 && isFinite(p.x) && isFinite(qq.w),
      `x=${p.x.toFixed(3)} (oldest ${xAt(OLDEST_T).toFixed(3)})`);
  }
}

// ---------------------------------------------------------------------------
// 6. Cannon lethality and what actually makes an aeroplane tough  (REQUIRED)
// ---------------------------------------------------------------------------

section('6. Cannon lethality: 20 mm against a Zero and a Mustang');

/**
 * How many cannon hits it takes to bring an aeroplane down.
 *
 * The engagement geometry matters more than anything else here, and getting it
 * wrong is how this test used to lie. Firing every shot from dead astern and
 * aiming at module *centres* means the tail boom is in front of everything
 * else: 100 % of the hits landed on TailBoom, every single kill was "tail shot
 * away", and the P-51/A6M5 ratio the test reported (1.34) was nothing but the
 * ratio of their tail hit points (135/97 = 1.39). Armour, self-sealing tanks,
 * the engine, the pilot and the fuel system were never touched by a single
 * round, so the test could not have noticed if they had been deleted.
 *
 * So: shots come from a spread of aspects across the rear hemisphere — the
 * real gun-attack cone — and each burst is aimed at a scattered point on the
 * target's silhouette rather than at one module. Hits then land across the
 * fuselage, both wings, the tail, the fuel tanks, the engine, the control
 * cables and occasionally the pilot, and kills come from wings torn off, tails
 * shot away, fires and dead pilots in realistic proportions.
 *
 * The belt is mixed HE / HEI / AP / API, which is what a 20 mm cannon actually
 * fired. A pure-HE belt never ignites anything, so self-sealing tanks — one of
 * the two things the Mustang is supposed to be tougher *because* of — cannot
 * show up at all.
 */
const ASPECTS: [number, number][] = [
  // azimuth off the nose (180° = dead astern), elevation
  [180, 0], [180, 12], [180, -12], [160, 6], [200, -6],
  [150, 18], [210, -18], [140, 0], [220, 10], [170, -20],
];

/**
 * A modified copy of an archetype for ablation experiments.
 *
 * The new id is load-bearing: 'buildAircraftProxy' memoises on 'spec.id', so a
 * variant that keeps the original id silently gets the original proxy — with
 * the original armour — and every ablation comes out as a no-op. That produces
 * a very convincing false negative.
 */
function variant(base: AircraftSpec, suffix: string, patch: Partial<AircraftSpec['damage']>): AircraftSpec {
  return { ...base, id: `${base.id}__${suffix}`, damage: { ...base.damage, ...patch } };
}

function targetFor(id: number, spec: AircraftSpec): CombatTarget {
  const q = mkq();
  qFromEuler(0, 0, 0, q);
  const hist = createHistoryBuffer(64);
  const t: CombatTarget = {
    id, team: 1, ownerId: id, alive: true,
    proxy: buildAircraftProxy(spec),
    p: v3(0, 1000, 0), q, v: v3(0, 0, 0), history: hist,
  };
  for (let i = 0; i < 20; i++) pushHistory(hist, i * 0.05, t.p, t.q);
  return t;
}

interface KillOutcome { hits: number; cause: string }

function killTest(
  spec: AircraftSpec, calibre: number, mass: number, he: number, muzzle: number, seed: number,
): KillOutcome {
  const RANGE = 250;
  const tgt = targetFor(10, spec);
  const dmg = createDamageState(spec, 10, 1, 10, seed);
  const env = makeEnv([tgt]);
  env.rng = new Rng(seed * 7919 + 13);
  const rnd = new Rng(seed * 31 + 7);
  const pool = new ProjectilePool(16);
  const list: import('./types').Projectile[] = [];
  const span = spec.aero.span;
  const len = spec.geom.length;
  const BELT = calibre >= 20
    ? [AmmoType.HE, AmmoType.HEI, AmmoType.AP, AmmoType.API]
    : [AmmoType.Ball, AmmoType.AP, AmmoType.Ball, AmmoType.API];
  let hitsLanded = 0;
  let shotsFired = 0;
  const cap = calibre >= 20 ? 200 : 600;

  while (!dmg.destroyed && shotsFired < cap) {
    const [azDeg, elDeg] = ASPECTS[shotsFired % ASPECTS.length];
    const ammo = BELT[shotsFired % BELT.length];
    const solid = ammo === AmmoType.AP || ammo === AmmoType.API;
    shotsFired++;
    const az = (azDeg * Math.PI) / 180;
    const el = (elDeg * Math.PI) / 180;
    const origin = v3(
      tgt.p.x + Math.sin(az) * Math.cos(el) * RANGE,
      tgt.p.y + Math.sin(el) * RANGE,
      tgt.p.z + Math.cos(az) * Math.cos(el) * RANGE,
    );
    // Aim at a scattered point on the silhouette — a burst, not a sniper shot.
    const aimX = tgt.p.x + (rnd.next() - 0.5) * span * 0.5;
    const aimY = tgt.p.y + (rnd.next() - 0.5) * 1.6;
    const aimZ = tgt.p.z + (rnd.next() - 0.5) * len * 0.6;
    const dx = aimX - origin.x, dy = aimY - origin.y, dz = aimZ - origin.z;
    const L = Math.hypot(dx, dy, dz) || 1;

    let landed = false;
    list.length = 0;
    list.push(createProjectile({
      origin, direction: v3(dx / L, dy / L, dz / L), speed: muzzle,
      ammo, calibre, mass, heGrams: solid ? 0 : he,
      ownerId: 1, team: 0, shooterEntity: 1, time: env.time, pool,
    }));
    for (let i = 0; i < 150 && list.length; i++) {
      env.time += 1 / 240;
      stepProjectiles(list, env, 1 / 240, (h: HitResult) => {
        if (h.targetId !== 10) return;
        if (h.module >= 0 && (h.type === 'penetrate' || h.type === 'stop')) landed = true;
        applyDamage(dmg, h);
      }, pool);
    }
    if (landed) hitsLanded++;
    // Let game time pass between hits so fires, leaks and wounds evolve.
    stepDamage(dmg, {
      time: env.time, gLoad: 1.6, ias: 120, tas: 130, altitude: 1000,
      sideslip: 0, throttle: 0.9, radiatorOpen: true,
      gLimit: spec.aero.gLimit, fuelBurn: 0.05, x: 0, y: 1000, z: 0,
    }, 0.5);
  }
  return { hits: dmg.destroyed ? hitsLanded : -1, cause: killReason(dmg) };
}

/** Mean hits to kill over many seeded engagements — one burst is far too noisy. */
function meanKill(
  spec: AircraftSpec, calibre: number, mass: number, he: number, muzzle = 860, runs = 24,
): number {
  let total = 0, n = 0;
  for (let k = 0; k < runs; k++) {
    const r = killTest(spec, calibre, mass, he, muzzle, 1000 + k * 613);
    if (r.hits > 0) { total += r.hits; n++; }
  }
  return n > 0 ? total / n : -1;
}

const ZERO = AIRCRAFT_BY_ID['a6m5'];
const P51 = AIRCRAFT_BY_ID['p51d'];

const zeroKill = meanKill(ZERO, 20, 0.130, 10.5);
const p51Kill = meanKill(P51, 20, 0.130, 10.5);

check('20 mm downs an A6M5 in a plausible number of hits',
  zeroKill >= 2 && zeroKill <= 7, `${zeroKill.toFixed(2)} hits on average`);

// REQUIRED: the Mustang must *demonstrably* absorb more cannon fire. A bare
// 'p51Kill > zeroKill' is not a test — it passes on 2.91 versus 2.90. The
// margin asserted here is a real one, and the measured figure (~1.4x) is
// carried by heavier structure plus self-sealing tanks, each of which is
// checked separately below so that the ratio cannot quietly become an
// accident of one hit-point number.
const ratio = p51Kill / zeroKill;
check('a P-51D demonstrably takes more 20 mm hits than an A6M5',
  ratio >= 1.30,
  `P-51D=${p51Kill.toFixed(2)}, A6M5=${zeroKill.toFixed(2)}, ratio=${ratio.toFixed(2)}x`);
check('...but not absurdly more — it is a fighter, not a bomber',
  ratio < 2.5, `ratio=${ratio.toFixed(2)}x`);

// Mechanism 1: self-sealing tanks. Strip them and nothing else, and the same
// aeroplane must go down measurably sooner.
const p51NoSeal = variant(P51, 'nosealing', { selfSealing: false });
const p51NoSealKill = meanKill(p51NoSeal, 20, 0.130, 10.5);
check('self-sealing tanks measurably contribute to the P-51D toughness',
  p51NoSealKill < p51Kill - 0.15,
  `sealed=${p51Kill.toFixed(2)} vs unsealed=${p51NoSealKill.toFixed(2)} hits`);

// Mechanism 2: structure. Give the Zero the Mustang's hit points and the gap
// must close — which pins the rest of the difference on the airframe rather
// than on some unrelated asymmetry in the test geometry.
const zeroBeefed = variant(ZERO, 'beefed', {
  hull: P51.damage.hull, wing: P51.damage.wing, tail: P51.damage.tail, engine: P51.damage.engine,
});
const zeroBeefedKill = meanKill(zeroBeefed, 20, 0.130, 10.5);
check('structure is the other half of it',
  zeroBeefedKill > zeroKill + 0.4 && zeroBeefedKill <= p51Kill + 0.6,
  `Zero=${zeroKill.toFixed(2)}, Zero with P-51 structure=${zeroBeefedKill.toFixed(2)}, `
  + `P-51=${p51Kill.toFixed(2)}`);

// Rifle-calibre ball must be dramatically less effective than cannon.
const zeroRifle = meanKill(ZERO, 7.7, 0.0115, 0, 811);
check('7.7 mm needs far more hits than 20 mm',
  zeroRifle > zeroKill * 3,
  `7.7 mm: ${zeroRifle.toFixed(1)} hits vs 20 mm: ${zeroKill.toFixed(1)}`);

// ---------------------------------------------------------------------------
// 7. Modular damage consequences
// ---------------------------------------------------------------------------

section('7. Modular damage consequences');

function blankHit(module: ModuleId, damage: number, ammo = AmmoType.AP): HitResult {
  return {
    type: 'penetrate', time: 1, projectileId: 1, kind: ProjectileKind.Shell,
    ammo, calibre: 20, heGrams: 0,
    ownerId: 1, team: 0, shooterEntity: 1,
    targetId: 99, module,
    px: 0, py: 1000, pz: 0, nx: 0, ny: 0, nz: 1, dx: 0, dy: 0, dz: -1,
    speed: 700, energy: 20000, damage, ignite: 0,
    penetrationMm: 30, effectiveArmourMm: 1, angleDeg: 0,
  };
}

{
  const spec = AIRCRAFT_BY_ID['bf109_g6'];
  const st = createDamageState(spec, 99, 1, 99, 77);
  applyDamage(st, blankHit(ModuleId.Engine, spec.damage.engine * 0.5));
  const fx = computeDamageEffects(st);
  check('engine hit costs power', fx.powerScale < 0.85, `powerScale=${fx.powerScale.toFixed(3)}`);
  check('engine hit sets the Engine damage bit', (st.bits & DamageBits.Engine) !== 0);
}

{
  const spec = AIRCRAFT_BY_ID['bf109_g6'];
  const st = createDamageState(spec, 99, 1, 99, 78);
  // Destroy the oil tank, then let time pass: oil runs out, the engine seizes.
  applyDamage(st, blankHit(ModuleId.OilTank, 1e6));
  let seized = false;
  for (let i = 0; i < 400 && !seized; i++) {
    stepDamage(st, {
      time: i * 0.25, gLoad: 1, ias: 120, tas: 130, altitude: 2000, sideslip: 0,
      throttle: 1, radiatorOpen: true, gLimit: spec.aero.gLimit, fuelBurn: 0,
      x: 0, y: 2000, z: 0,
    }, 0.25);
    seized = st.engineSeized;
  }
  check('oil loss eventually seizes the engine', seized);
  const fx = computeDamageEffects(st);
  check('a seized engine makes no power and lots of drag',
    fx.powerScale === 0 && fx.cd0Add > 0.02,
    `power=${fx.powerScale} cd0Add=${fx.cd0Add.toFixed(4)}`);
}

{
  const spec = AIRCRAFT_BY_ID['a6m5'];   // no self-sealing tanks
  const st = createDamageState(spec, 99, 1, 99, 79);
  const h = blankHit(ModuleId.FuelLeft, 25, AmmoType.API);
  h.ignite = 1;
  applyDamage(st, h);
  check('fuel tank hit produces a leak', st.fuelLeak > 0, `${st.fuelLeak.toFixed(3)} kg/s`);
  check('an unsealed tank hit by API catches fire', st.fires.length > 0);
}

{
  // Self-sealing tanks must be measurably better.
  let unsealedFires = 0, sealedFires = 0;
  for (let i = 0; i < 200; i++) {
    const a = createDamageState(AIRCRAFT_BY_ID['a6m5'], 99, 1, 99, 1000 + i);
    const b = createDamageState(AIRCRAFT_BY_ID['p51d'], 99, 1, 99, 1000 + i);
    const h = blankHit(ModuleId.FuelLeft, 20, AmmoType.API);
    h.ignite = 0.5;
    applyDamage(a, h); applyDamage(b, h);
    if (a.fires.length) unsealedFires++;
    if (b.fires.length) sealedFires++;
  }
  check('self-sealing tanks halve the fire rate',
    sealedFires < unsealedFires * 0.7,
    `unsealed=${unsealedFires}/200 sealed=${sealedFires}/200`);
}

{
  const spec = AIRCRAFT_BY_ID['spitfire_mk9'];
  const st = createDamageState(spec, 99, 1, 99, 80);
  applyDamage(st, blankHit(ModuleId.CableRoll, 1e6));
  const fx = computeDamageEffects(st);
  check('a severed roll cable removes roll authority',
    fx.rollAuthority === 0 && (st.bits & DamageBits.ControlsSevered) !== 0);
  check('pitch still works after a roll cable cut', fx.pitchAuthority > 0.5);
}

{
  const spec = AIRCRAFT_BY_ID['spitfire_mk9'];
  const st = createDamageState(spec, 99, 1, 99, 81);
  // Half the left spar shot away, then a hard pull.
  applyDamage(st, blankHit(ModuleId.SparLeft, spec.damage.wing * 0.8 * 0.55));
  const fx = computeDamageEffects(st);
  check('spar damage lowers the g limit', fx.gLimitScale < 0.9, `gLimitScale=${fx.gLimitScale.toFixed(3)}`);
  let ripped = false;
  for (let i = 0; i < 200 && !ripped; i++) {
    stepDamage(st, {
      time: i * 0.05, gLoad: spec.aero.gLimit * 0.95, ias: 160, tas: 170,
      altitude: 3000, sideslip: 0, throttle: 1, radiatorOpen: true,
      gLimit: spec.aero.gLimit, fuelBurn: 0, x: 0, y: 3000, z: 0,
    }, 0.05);
    ripped = st.wingOff[0];
  }
  check('a damaged spar folds under sustained high g', ripped);
  check('losing a wing is fatal', st.destroyed && (st.bits & DamageBits.WingRipped) !== 0);
}

{
  const spec = AIRCRAFT_BY_ID['p51d'];
  const st = createDamageState(spec, 99, 1, 99, 82);
  applyDamage(st, blankHit(ModuleId.Pilot, 200));
  check('a heavy pilot hit kills the pilot and the aircraft',
    st.pilotDead && st.destroyed && (st.bits & DamageBits.PilotDead) !== 0);
}

{
  // Fire must go out if you dive fast and slip, and must not if you loiter.
  let outFast = 0, outSlow = 0;
  const trials = 120;
  for (let i = 0; i < trials; i++) {
    const fast = createDamageState(AIRCRAFT_BY_ID['a6m5'], 99, 1, 99, 5000 + i);
    const slow = createDamageState(AIRCRAFT_BY_ID['a6m5'], 99, 1, 99, 5000 + i);
    const h = blankHit(ModuleId.FuelLeft, 5, AmmoType.HEI);
    h.ignite = 1;
    applyDamage(fast, h); applyDamage(slow, h);
    for (let k = 0; k < 40; k++) {
      stepDamage(fast, {
        time: k * 0.25, gLoad: 1, ias: 175, tas: 190, altitude: 2000,
        sideslip: 0.22, throttle: 0, radiatorOpen: true, gLimit: 9,
        fuelBurn: 0, x: 0, y: 2000, z: 0,
      }, 0.25);
      stepDamage(slow, {
        time: k * 0.25, gLoad: 1, ias: 45, tas: 48, altitude: 2000,
        sideslip: 0, throttle: 0.4, radiatorOpen: true, gLimit: 9,
        fuelBurn: 0, x: 0, y: 2000, z: 0,
      }, 0.25);
    }
    if (fast.fires.length === 0 && !fast.destroyed) outFast++;
    if (slow.fires.length === 0 && !slow.destroyed) outSlow++;
  }
  check('diving fast and slipping puts fires out more often than loitering',
    outFast > outSlow * 1.5,
    `fast=${outFast}/${trials} slow=${outSlow}/${trials}`);
}

{
  const spec = AIRCRAFT_BY_ID['p51d'];
  const st = createDamageState(spec, 99, 1, 99, 83);
  check('a clean aircraft has full health', healthFraction(st) > 0.99);
  const fx = computeDamageEffects(st);
  check('a clean aircraft has neutral modifiers',
    fx.powerScale === 1 && fx.clScale === 1 && fx.cd0Add === 0
    && fx.rollAuthority === 1 && fx.pitchAuthority === 1 && fx.pilotControl === 1);
}

// ---------------------------------------------------------------------------
// 8. Armour actually protects
// ---------------------------------------------------------------------------

section('8. Armour behaviour in flight');

{
  // A 7.7 mm round from dead astern into a Spitfire must be stopped by the
  // pilot's 9 mm back plate; the same shot into an unarmoured Zero must not.
  function asternPilotShot(spec: AircraftSpec, calibre: number, mass: number): { stopped: boolean; reached: boolean } {
    const tgt = targetFor(20, spec);
    const proxy = buildAircraftProxy(spec);
    const pilot = proxy.shapes.find((s) => s.module === ModuleId.Pilot)!;
    const env = makeEnv([tgt]);
    const list: import('./types').Projectile[] = [];
    let stopped = false, reached = false;
    list.push(createProjectile({
      origin: v3(pilot.centre.x, 1000 + pilot.centre.y, pilot.centre.z - 200),
      direction: v3(0, 0, 1), speed: 811,
      ammo: AmmoType.AP, calibre, mass,
      ownerId: 1, team: 0, shooterEntity: 1, time: 0,
    }));
    for (let i = 0; i < 150 && list.length; i++) {
      env.time = i / 240;
      stepProjectiles(list, env, 1 / 240, (h: HitResult) => {
        if (h.targetId !== 20 || h.module !== ModuleId.Pilot) return;
        reached = true;
        if (h.type === 'stop') stopped = true;
      });
    }
    return { stopped, reached };
  }
  const spitSpec = AIRCRAFT_BY_ID['spitfire_mk9'];
  const zeroSpec = AIRCRAFT_BY_ID['a6m5'];
  const spit = asternPilotShot(spitSpec, 7.7, 0.0115);
  const zero = asternPilotShot(zeroSpec, 7.7, 0.0115);
  check('7.7 mm astern shot reaches the pilot box on both types', spit.reached && zero.reached);
  check('the Spitfire back plate stops a 7.7 mm astern shot', spit.stopped);
  check('the unarmoured Zero does not stop it', !zero.stopped);
  check('the P-51D back plate stops it too',
    asternPilotShot(AIRCRAFT_BY_ID['p51d'], 7.7, 0.0115).stopped);

  // Causality, not correlation — and measured on the pilot, not on a flag.
  //
  // Comparing two different aeroplanes only shows that *something* about the
  // Spitfire stops the round. The honest experiment is the same aeroplane with
  // nothing changed but the back plate. It is scored on how much of the pilot
  // is left after a sustained burst rather than on the per-round 'stop' flag,
  // because that flag does not mean what it looks like it means: an unarmoured
  // pilot box records both an entry and an exit, so 'stopped' comes out true
  // for a round that sailed straight through and out the other side.
  function pilotAfterBurst(spec: AircraftSpec, calibre: number, mass: number, speed: number): number {
    const tgt = targetFor(21, spec);
    const proxy = buildAircraftProxy(spec);
    const pilot = proxy.shapes.find((s) => s.module === ModuleId.Pilot)!;
    const env = makeEnv([tgt]);
    const dmg = createDamageState(spec, 21, 1, 21, 5);
    for (let k = 0; k < 20; k++) {
      const list: import('./types').Projectile[] = [];
      list.push(createProjectile({
        origin: v3(pilot.centre.x, 1000 + pilot.centre.y, pilot.centre.z - 200),
        direction: v3(0, 0, 1), speed, ammo: AmmoType.AP, calibre, mass,
        ownerId: 1, team: 0, shooterEntity: 1, time: 0,
      }));
      for (let i = 0; i < 150 && list.length; i++) {
        env.time = i / 240;
        stepProjectiles(list, env, 1 / 240, (h: HitResult) => {
          if (h.targetId === 21) applyDamage(dmg, h);
        });
      }
    }
    return dmg.pilotHp;
  }
  const spitNoArmour = variant(spitSpec, 'noarmour', {
    armour: { pilotBack: 0, pilotFront: 0, engineFront: 0, fuel: 0 },
  });
  const hpArmoured = pilotAfterBurst(spitSpec, 7.7, 0.0115, 811);
  const hpBare = pilotAfterBurst(spitNoArmour, 7.7, 0.0115, 811);
  check('it is the plate doing it — remove it and the pilot gets shot to pieces',
    hpArmoured > hpBare * 2.5,
    `pilot HP after 20 rounds: ${hpArmoured.toFixed(1)} with the plate, `
    + `${hpBare.toFixed(1)} without`);

  // The plate helps against .50 too, but by much less — which is the right
  // shape for 9 mm of steel against a round that can defeat about 20 mm.
  const hp50Armoured = pilotAfterBurst(spitSpec, 12.7, 0.046, 880);
  const hp50Bare = pilotAfterBurst(spitNoArmour, 12.7, 0.046, 880);
  check('the plate helps less against .50 than against rifle calibre',
    hp50Armoured > hp50Bare
    && (hp50Armoured / hp50Bare) < (hpArmoured / hpBare),
    `.50: ${hp50Armoured.toFixed(1)} vs ${hp50Bare.toFixed(1)} `
    + `(${(hp50Armoured / hp50Bare).toFixed(2)}x), 7.7 mm: ${(hpArmoured / hpBare).toFixed(2)}x`);

  // And the plate has limits: 9 mm is rifle-calibre protection, not cannon
  // protection. A 20 mm AP shell at 250 m carries far more than enough
  // penetration, and a model where a back plate shrugs off cannon fire would
  // make every armoured fighter invulnerable to its historical killer.
  const cannonPen = penetrationCapability(AmmoType.AP, 20, 0.130, 800);
  check('a 20 mm AP shell out-penetrates a fighter back plate several times over',
    cannonPen > spitSpec.damage.armour.pilotBack * 2.5,
    `${cannonPen.toFixed(1)} mm RHA vs ${spitSpec.damage.armour.pilotBack} mm plate`);
}

// ---------------------------------------------------------------------------
// 9. Ordnance
// ---------------------------------------------------------------------------

section('9. Ordnance');

{
  const bomb = bombSpecFromKg(250);
  inRange('250 kg bomb diameter', bomb.diameter, 0.25, 0.45, ' m');
  const env = makeEnv([], 0);
  const out = v3();
  // Level release at 300 m, 140 m/s. Vacuum solution: t = √(2h/g) = 7.82 s,
  // forward throw = 1095 m. Drag must shorten both, but not by much for a
  // dense bomb.
  const t = predictBombImpact(bomb, v3(0, 300, 0), v3(0, 0, 140), env, out);
  inRange('250 kg bomb fall time from 300 m', t, 7.6, 8.4, ' s');
  inRange('250 kg bomb forward throw', out.z, 950, 1120, ' m');
  check('impact point is at ground level', Math.abs(out.y) < 2, `${out.y.toFixed(2)} m`);
}

{
  // A bomb with a delay fuse must survive contact with the ground, then go off.
  const spec = bombSpecFromKg(250);
  spec.fuseDelay = 1.0;
  const env = makeEnv([], 0);
  const list: import('./types').Projectile[] = [];
  list.push(dropBomb({
    spec, origin: v3(0, 60, 0), velocity: v3(0, 0, 150),
    ownerId: 1, team: 0, shooterEntity: 1, time: 0,
  }));
  let detonatedAt = -1;
  let landedAt = -1;
  for (let i = 0; i < 1200 && list.length; i++) {
    env.time = i / 120;
    stepProjectiles(list, env, 1 / 120, (h: HitResult) => {
      if ((h.type === 'terrain' || h.type === 'water') && landedAt < 0) landedAt = env.time;
      if (h.type === 'detonate') detonatedAt = env.time;
    });
  }
  check('delay-fused bomb lands then detonates later',
    landedAt >= 0 && detonatedAt > landedAt + 0.8,
    `land=${landedAt.toFixed(2)}s detonate=${detonatedAt.toFixed(2)}s`);
}

{
  // Rockets must accelerate hard during boost and then scatter. Dispersion is
  // measured *laterally* (in x, and in y about the mean), because the mean
  // vertical offset is gravity drop, not error.
  const rspec = defaultRocketSpec();
  const env = makeEnv([], -1e6);
  const rng = new Rng(999);
  const xs: number[] = [];
  const ys: number[] = [];
  let peak = 0;
  for (let k = 0; k < 60; k++) {
    const list: import('./types').Projectile[] = [];
    const r = launchRocket({
      spec: rspec, origin: v3(0, 1000, 0), direction: v3(0, 0, 1),
      velocity: v3(0, 0, 120), ownerId: 1, team: 0, shooterEntity: 1,
      time: 0, rng,
    });
    list.push(r);
    while (list.length && r.p.z < 900 && r.t < 12) {
      stepProjectiles(list, env, 1 / 120, () => {});
      const sp = vlen(r.v);
      if (sp > peak) peak = sp;
    }
    xs.push(r.p.x);
    ys.push(r.p.y - 1000);
  }
  inRange('rocket peak speed', peak, 380, 900, ' m/s');
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sd = (arr: number[], mean: number) =>
    Math.sqrt(arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length);
  const sdX = sd(xs, 0);
  const sdY = sd(ys, meanY);
  inRange('rocket lateral 1-sigma at ~900 m', sdX, 3, 40, ' m');
  inRange('rocket vertical 1-sigma at ~900 m', sdY, 2, 40, ' m');
  inRange('rocket mean drop at ~900 m (gravity)', -meanY, 8, 70, ' m');
  check('rocket dispersion is not degenerate',
    xs.some((d) => d > sdX * 0.8) && xs.some((d) => d < -sdX * 0.8),
    `sdX=${sdX.toFixed(1)} m`);
}

{
  // Bomb blast must damage a nearby aircraft and be shielded by terrain.
  function bombOnTarget(occlude: boolean): number {
    const tgt = makeTarget(30, 'a6m5', { x: 0, y: 6, z: 0 });
    const spec = AIRCRAFT_BY_ID['a6m5'];
    const st = createDamageState(spec, 30, 1, 30, 11);
    const env = makeEnv([tgt], 0);
    if (occlude) env.terrainOccludes = () => true;
    const list: import('./types').Projectile[] = [];
    list.push(dropBomb({
      spec: bombSpecFromKg(250), origin: v3(0, 40, 0), velocity: v3(0, -60, 0),
      ownerId: 1, team: 0, shooterEntity: 1, time: 0,
    }));
    for (let i = 0; i < 600 && list.length; i++) {
      env.time = i / 120;
      stepProjectiles(list, env, 1 / 120, (h: HitResult) => { applyDamage(st, h); });
    }
    return st.totalDamage;
  }
  const open = bombOnTarget(false);
  const shielded = bombOnTarget(true);
  check('a 250 kg bomb bursting 6 m away hurts', open > 40, `${open.toFixed(0)} damage`);
  check('terrain shields blast', shielded < open * 0.5, `open=${open.toFixed(0)} shielded=${shielded.toFixed(0)}`);
}

// ---------------------------------------------------------------------------
// 10. AA guns
// ---------------------------------------------------------------------------

section('10. AA guns and flak');

{
  // A light battery firing at a crossing target must lead it, not track it.
  const tgt = makeTarget(40, 'p51d', { x: 0, y: 600, z: 900 }, 0, 0);
  vset(tgt.v, 160, 0, 0);
  const env = makeEnv([tgt], 0);
  const gun = createAaGun(1, 1, v3(0, 0, 0), AA_LIGHT, 5);
  const list: import('./types').Projectile[] = [];
  let fired = 0;
  let firstShotTime = -1;
  for (let i = 0; i < 600; i++) {
    env.time = i / 60;
    // Fly the target.
    tgt.p.x += tgt.v.x / 60;
    pushHistory(tgt.history!, env.time, tgt.p, tgt.q);
    stepAaGuns([gun], [tgt], 1 / 60, { env, out: list });
    if (list.length > fired) {
      if (firstShotTime < 0) firstShotTime = env.time;
      fired = list.length;
    }
  }
  check('the light battery opens fire', fired > 20, `${fired} rounds`);
  check('the crew takes a reaction delay before firing',
    firstShotTime > 0.4, `first shot at ${firstShotTime.toFixed(2)}s`);
  // Rounds must be aimed ahead of the target, not at it.
  const lead = v3();
  const tof = solveLead(gun.p, tgt.p, tgt.v, AA_LIGHT.muzzle, G0, lead);
  const straight = vnorm(vsub(tgt.p, gun.p, v3()), v3());
  const angle = Math.acos(Math.max(-1, Math.min(1, lead.x * straight.x + lead.y * straight.y + lead.z * straight.z)));
  check('the lead solution differs from the line of sight',
    angle > 0.05, `${(angle * 180 / Math.PI).toFixed(1)}° lead, tof=${tof.toFixed(2)}s`);
}

{
  // Heavy flak must function on its *time fuse* rather than by striking the
  // aircraft, and the bursts must bracket the target rather than track it.
  const tgt = makeTarget(41, 'p51d', { x: 0, y: 5000, z: 9000 }, 0, 0);
  vset(tgt.v, 0, 0, -120);
  const env = makeEnv([tgt], 0);
  const guns = [
    createAaGun(2, 1, v3(0, 0, 0), AA_HEAVY, 3),
    createAaGun(3, 1, v3(400, 0, 300), AA_HEAVY, 9),
    createAaGun(4, 1, v3(-350, 0, -200), AA_HEAVY, 17),
  ];
  const list: import('./types').Projectile[] = [];
  let bursts = 0;
  let impacts = 0;
  let closest = Infinity;
  for (let i = 0; i < 6000; i++) {
    env.time = i / 60;
    tgt.p.z += tgt.v.z / 60;
    if (tgt.p.z < -3000) break;
    pushHistory(tgt.history!, env.time, tgt.p, tgt.q);
    stepAaGuns(guns, [tgt], 1 / 60, { env, out: list });
    stepProjectiles(list, env, 1 / 60, (h: HitResult) => {
      if (h.type === 'detonate') {
        bursts++;
        const d = Math.hypot(h.px - tgt.p.x, h.py - tgt.p.y, h.pz - tgt.p.z);
        if (d < closest) closest = d;
      }
      if (h.type === 'terrain' || h.type === 'water') impacts++;
    });
  }
  check('heavy flak produces airbursts', bursts > 5, `${bursts} bursts`);
  check('flak functions on the fuse, not on the ground',
    bursts > impacts, `${bursts} airbursts vs ${impacts} ground impacts`);
  check('flak bursts bracket the target',
    closest < 400, `closest burst ${closest.toFixed(0)} m`);
}

{
  // A burst at a realistic proximity must actually put fragments through the
  // airframe. This is the flak *lethality* mechanism, tested directly rather
  // than waiting for a stochastic 1-in-a-thousand near miss.
  const tgt = makeTarget(42, 'p51d', { x: 0, y: 5000, z: 0 }, 0, 0);
  const spec = AIRCRAFT_BY_ID['p51d'];
  const st = createDamageState(spec, 42, 0, 42, 21);
  const env = makeEnv([tgt], -1e6);
  env.time = 1;
  let frags = 0;
  // 88 mm shell: 9.4 kg with 900 g of filler, bursting 12 m away.
  detonateAt(env, 0, 5000 + 12, 0, 9.4, 900 / 9400, 0, 1, 0, (h: HitResult) => {
    if (h.type === 'fragment' || h.type === 'blast') frags++;
    applyDamage(st, h);
  });
  check('an 88 mm burst 12 m away sprays the airframe', frags > 0, `${frags} module hits`);
  check('...and does meaningful damage', st.totalDamage > 20, `${st.totalDamage.toFixed(0)} damage`);
}

// ---------------------------------------------------------------------------
// 11. Determinism
// ---------------------------------------------------------------------------

section('11. Determinism');

{
  function run(seed: number): string {
    const tgt = makeTarget(50, 'bf109_g6', { x: 0, y: 1000, z: 0 });
    const spec = AIRCRAFT_BY_ID['bf109_g6'];
    const st = createDamageState(spec, 50, 1, 50, seed);
    const env: CombatEnv = {
      time: 0,
      queryTargets: (_a, _b, _c, out) => out.push(tgt),
      terrainHeight: () => -1e6,
      rng: new Rng(seed),
    };
    const list: import('./types').Projectile[] = [];
    for (let s = 0; s < 8; s++) {
      list.push(createProjectile({
        origin: v3((s % 3) * 0.4 - 0.4, 1000 + (s % 2) * 0.3, -180),
        direction: v3(0, 0, 1), speed: 800,
        ammo: s % 2 ? AmmoType.HE : AmmoType.AP, calibre: 20, mass: 0.115,
        heGrams: s % 2 ? 18.6 : 0,
        ownerId: 1, team: 0, shooterEntity: 1, time: 0,
      }));
    }
    for (let i = 0; i < 120 && list.length; i++) {
      env.time = i / 240;
      stepProjectiles(list, env, 1 / 240, (h: HitResult) => applyDamage(st, h));
    }
    return `${st.totalDamage.toFixed(6)}|${st.bits}|${st.fires.length}|${st.destroyed}`;
  }
  check('identical seeds give identical outcomes', run(31337) === run(31337));
  check('different seeds diverge', run(31337) !== run(4242));
}

// ---------------------------------------------------------------------------

console.log(`\n[1m${passed} passed, ${failed} failed[0m`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
// 'process' is not in this project's 'types' list (the client build is
// browser-only), so reach it dynamically rather than pulling @types/node in.
const proc = (globalThis as unknown as { process?: { exit(code: number): void } }).process;
if (proc) proc.exit(failed > 0 ? 1 : 0);
