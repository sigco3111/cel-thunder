/**
 * Playability test — drives the game the way a human does.
 *
 * The screenshot harness uses `debugFraming()`, which teleports a camera and
 * poses an aircraft. That proves the renderer works; it proves nothing about
 * whether the game is playable. This script instead goes through the real
 * front door: load, dismiss the menu, deploy, then fly with actual keyboard
 * and mouse events and check that the aeroplane responds like an aeroplane.
 *
 * It runs the suite TWICE — once against the offline sandbox and once against
 * the authoritative server — because the two paths spawn, integrate and
 * reconcile through completely different code and have historically failed in
 * completely different ways. A run that does not say which one it tested is
 * worthless: the last round of "confirmed bugs" here were all online-path
 * failures, diagnosed as offline ones because a dev server happened to be
 * running in another terminal.
 *
 * Thresholds are deliberately tight enough to fail on a broken build:
 *   - the spawn must be above terrain, healthy and at a real cruise speed;
 *   - reported velocity must match measured displacement (this is what caught
 *     a 7 000 m/s `vel` on an aeroplane that was climbing at 10 m/s);
 *   - pitch, roll and throttle must produce climb, turn and acceleration, not
 *     merely "some orientation delta";
 *   - the HUD's numbers must agree with the flight model's.
 *
 * Usage: node tools/playtest.mjs [--headed] [--offline-only] [--online-only]
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const OFFLINE_ONLY = argv.includes('--offline-only');
const ONLINE_ONLY = argv.includes('--online-only');
/**
 * The harness runs its own web server on its own port, with HMR off (see
 * vite.config.ts). Sharing the developer's :5233 means any file touched during
 * the two-minute run full-reloads the tab mid-test.
 */
const PORT = 5234;
const WEB = `http://localhost:${PORT}`;
const GAME_SERVER = 'http://localhost:8791/health';
const OUT = 'shots/playtest';

/** Pointing the client at a dead socket is how we force the offline sandbox. */
const OFFLINE_URL = `${WEB}/?server=ws://127.0.0.1:8799/ws`;

const KMH = 3.6;
const DEG = 180 / Math.PI;

let suite = '';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ suite, name, pass, detail });
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
  return pass;
};

async function reachable(url, timeoutMs) {
  const start = Date.now();
  do {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up */ }
    await sleep(400);
  } while (Date.now() - start < timeoutMs);
  return false;
}

let devProc = null;
let gameProc = null;

// ---------------------------------------------------------------------------
// In-page probes
// ---------------------------------------------------------------------------

/** One consistent snapshot of everything a pilot could observe. */
const SAMPLE = () => {
  const g = window.__game;
  const flight = g?.get?.('flight');
  const e = g?.entities?.get(g.localEntityId);
  const air = flight?.airData;
  const ui = g?.get?.('ui');
  const hud = ui?.telemetry?.data ?? null;
  if (!e) return null;
  // Compass heading of the body +Z axis.
  const fx = 2 * (e.qx * e.qz + e.qw * e.qy);
  const fz = 1 - 2 * (e.qx * e.qx + e.qy * e.qy);
  return {
    t: performance.now() / 1000,
    px: e.px, py: e.py, pz: e.pz,
    vx: e.vx, vy: e.vy, vz: e.vz,
    speed: Math.hypot(e.vx, e.vy, e.vz),
    qx: e.qx, qy: e.qy, qz: e.qz, qw: e.qw,
    heading: Math.atan2(fx, fz),
    throttle: e.throttle, rpm: e.rpm, health: e.health, damage: e.damage,
    air: air ? { ...air } : null,
    hud: hud ? { ias: hud.ias, altBaro: hud.altBaro, gLoad: hud.gLoad, alive: hud.alive } : null,
    offline: !!flight?.offline,
    shared: !!flight?.usingSharedModel,
    pred: flight?.predictionStats ? { ...flight.predictionStats } : null,
    camX: g.camera.position.x, camY: g.camera.position.y, camZ: g.camera.position.z,
  };
};

const COUNT_PROJECTILES = () => {
  const g = window.__game;
  let n = 0;
  for (const e of g.entities.values()) if (e.kind === 2) n++;
  return n;
};

const SCREEN = () => window.__game?.get?.('ui')?.screen ?? '?';

/**
 * Clicks a real button with a real mouse press at its real coordinates.
 *
 * Synthetic 'dispatchEvent(new MouseEvent("click"))' is not good enough: it
 * reaches the DOM handler but never touches the input subsystem's pointer
 * state, and a test that used it sat in the menu for its whole run while
 * happily reporting that the aircraft had "spawned" — it was only ever looking
 * at the sandbox's own AI roster.
 */
async function clickButton(page, selector, label) {
  const box = await page.evaluate(({ sel, want }) => {
    const rx = want ? new RegExp(want, 'i') : null;
    const n = [...document.querySelectorAll(sel)]
      .find((b) => (!rx || rx.test((b.textContent || '').trim())) && b.getBoundingClientRect().width > 2);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, { sel: selector, want: label });
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
}

/**
 * Waits for a control to be on screen and clickable. '__ready' only means the
 * subsystems booted — the loading curtain is still up for a second or two
 * after it on a cold Vite start, and clicking through it hits nothing.
 */
async function waitForControl(page, selector, label, timeoutMs = 45000) {
  const start = Date.now();
  do {
    const ok = await page.evaluate(({ sel, want }) => {
      const rx = want ? new RegExp(want, 'i') : null;
      return [...document.querySelectorAll(sel)].some((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 2 && r.height > 2 && (!rx || rx.test((b.textContent || '').trim()));
      });
    }, { sel: selector, want: label });
    if (ok) return true;
    await sleep(250);
  } while (Date.now() - start < timeoutMs);
  return false;
}

/** Waits for the UI to reach a screen, since menu transitions are animated. */
async function waitForScreen(page, want, timeoutMs = 8000) {
  const start = Date.now();
  do {
    if ((await page.evaluate(SCREEN)) === want) return true;
    await sleep(200);
  } while (Date.now() - start < timeoutMs);
  return false;
}

/** Wraps to (−180, 180] so a turn through north is not a 350° turn. */
const wrapDeg = (d) => ((d + 540) % 360) - 180;

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  if (!(await reachable(WEB, 800))) {
    devProc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
      stdio: 'ignore',
      env: { ...process.env, CT_NO_HMR: '1' },
    });
    if (!(await reachable(WEB, 90000))) throw new Error('web server failed to start');
  }

  let haveServer = false;
  if (!OFFLINE_ONLY) {
    haveServer = await reachable(GAME_SERVER, 1200);
    if (!haveServer) {
      gameProc = spawn('npx', ['tsx', 'server/index.ts'], { stdio: 'ignore', env: process.env });
      haveServer = await reachable(GAME_SERVER, 60000);
    }
  }

  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
  });

  console.log('\n\x1b[1mCEL THUNDER — playability test\x1b[0m');

  if (!ONLINE_ONLY) await guarded(browser, 'offline', OFFLINE_URL);
  if (!OFFLINE_ONLY) {
    if (haveServer) await guarded(browser, 'online', WEB);
    else check('authoritative server reachable', false, 'could not start server/index.ts');
  }

  await finish(browser);
}

/**
 * A suite that throws has itself failed — most often because the aircraft
 * stopped existing mid-flight, which is exactly the sort of thing this test is
 * for. Record it as a failure rather than letting the process die with a
 * stack trace and no score.
 */
async function guarded(browser, mode, url) {
  try {
    await runSuite(browser, mode, url);
  } catch (err) {
    suite = mode;
    check('suite ran to completion', false, String(err?.message ?? err).slice(0, 160));
  }
}

/**
 * One full pass: boot, deploy, fly, shoot, look around, survive.
 * 'mode' is only used for labelling and screenshot paths — everything else is
 * identical, which is the point: the two paths must behave the same.
 */
async function runSuite(browser, mode, url) {
  suite = mode;
  const tag = `${OUT}/${mode}`;
  console.log(`\n\x1b[1m═══ ${mode.toUpperCase()} ═══\x1b[0m`);

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  const navigations = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });

  /** Never returns null: an aircraft that vanished is a failure, not a crash. */
  const sample = async () => {
    const s = await page.evaluate(SAMPLE);
    if (!s) throw new Error('the player aircraft disappeared from the world');
    return s;
  };

  // --- 1. boot ---------------------------------------------------------------
  console.log('\n1. Boot');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const booted = await page.waitForFunction('window.__ready === true', { timeout: 90000 })
    .then(() => true).catch(() => false);
  check('game reaches ready state', booted);
  if (!booted) { await page.close(); return; }

  const menuUp = await waitForControl(page, 'button.ct-navitem', 'play');
  await page.screenshot({ path: `${tag}-01-menu.png` });

  const failed = await page.evaluate(() => window.__game?.failedSubsystems ?? []);
  check('all subsystems initialised', failed.length === 0,
    failed.length ? failed.map((f) => f.name).join(', ') : '');

  // --- 2. menu and deployment ------------------------------------------------
  console.log('\n2. Menu and deployment');
  check('main menu is present and interactive', menuUp);

  const clickedPlay = await clickButton(page, 'button.ct-navitem', 'play');
  const inHangar = clickedPlay && await waitForScreen(page, 'hangar');
  check('Play opens the hangar', inHangar,
    inHangar ? '' : `screen is "${await page.evaluate(SCREEN)}"`);
  await page.screenshot({ path: `${tag}-02-hangar.png` });

  await waitForControl(page, 'button.ct-btn.is-primary', 'deploy', 15000);
  const clickedDeploy = await clickButton(page, 'button.ct-btn.is-primary', 'deploy');
  const inFlight = clickedDeploy && await waitForScreen(page, 'flight');
  check('Deploy puts the player in the cockpit', inFlight,
    inFlight ? '' : `screen is "${await page.evaluate(SCREEN)}"`);

  // Centre the pointer before measuring anything. The default scheme is mouse
  // aim, so the cursor *is* the stick: leaving it parked over the Deploy
  // button means the first thing the aeroplane does is bunt into a dive, and
  // that is the pilot's doing, not the game's.
  await page.mouse.move(800, 450, { steps: 6 });
  await sleep(4000);
  await page.screenshot({ path: `${tag}-03-deployed.png` });

  const spawned = await page.evaluate(() => ({
    id: window.__game?.localEntityId ?? 0,
    entities: window.__game?.entities?.size ?? 0,
  }));
  check('player aircraft spawned', spawned.id !== 0,
    `entityId=${spawned.id}, ${spawned.entities} entities`);
  if (!inFlight || spawned.id === 0) {
    console.log('\n  cannot continue: not flying. Remaining checks skipped.');
    await page.close();
    return;
  }

  const controlling = await page.evaluate(() => {
    const i = window.__game?.get?.('input');
    return { suspended: !!i?.suspended, scheme: i?.scheme };
  });
  check('the player has control of the aircraft', !controlling.suspended,
    `scheme=${controlling.scheme}, suspended=${controlling.suspended}`);

  const s0 = await sample();
  check('flight model is the shared one', !!s0?.shared);
  check(`running the ${mode} path`, !!s0 && s0.offline === (mode === 'offline'),
    s0 ? `offline=${s0.offline}` : '');

  // --- 3. the spawn itself ---------------------------------------------------
  // Every one of these has been violated by a shipped build: spawned inside a
  // mountain, spawned already destroyed, spawned at 20 000 km/h.
  console.log('\n3. Spawn condition');
  const air0 = s0?.air;
  check('spawn state is readable', !!air0);

  check('spawned above the terrain, at a sane height',
    !!air0 && air0.agl > 150 && air0.agl < 8000,
    air0 ? `AGL ${air0.agl.toFixed(0)} m, alt ${air0.altitude.toFixed(0)} m` : '');

  check('spawned in a healthy airframe',
    !!air0 && air0.health >= 0.999 && air0.damage === 0 && !air0.onGround,
    air0 ? `health ${air0.health.toFixed(3)}, damage ${air0.damage}` : '');

  check('indicated airspeed is a real cruise speed',
    !!air0 && air0.ias * KMH > 200 && air0.ias * KMH < 750,
    air0 ? `IAS ${(air0.ias * KMH).toFixed(0)} km/h, TAS ${(air0.tas * KMH).toFixed(0)} km/h` : '');

  // Not "vertical speed is zero": the player is handed a wide-open throttle,
  // and a Spitfire at full power settles into a genuine 25-30 m/s climb. What
  // must be true is that nothing violent is happening and the nose is not
  // going down.
  check('spawned settled, at 1 g, not falling',
    !!air0 && Math.abs(air0.gLoad - 1) < 0.8 && air0.vertSpeed > -12 && air0.vertSpeed < 45,
    air0 ? `${air0.gLoad.toFixed(2)} g, VS ${air0.vertSpeed.toFixed(1)} m/s` : '');

  // --- 4. velocity means what it says ---------------------------------------
  // The reported velocity vector must integrate to the observed displacement.
  // A ground-contact blow-up, a unit error or a state written into the wrong
  // slot all show up here and nowhere else.
  console.log('\n4. Velocity consistency');
  const a = await sample();
  await sleep(2000);
  const b = await sample();
  const dt = b.t - a.t;
  const measured = Math.hypot(b.px - a.px, b.py - a.py, b.pz - a.pz) / dt;
  const reported = 0.5 * (a.speed + b.speed);
  const relErr = Math.abs(measured - reported) / Math.max(1, reported);
  check('reported velocity matches measured displacement', relErr < 0.15,
    `reported ${(reported * KMH).toFixed(0)} km/h vs measured ${(measured * KMH).toFixed(0)} km/h`
    + ` (${(relErr * 100).toFixed(1)} % off)`);
  check('speed is physically possible for a piston fighter',
    reported * KMH > 150 && reported * KMH < 900, `${(reported * KMH).toFixed(0)} km/h`);

  // --- 5. the HUD agrees with the simulation --------------------------------
  console.log('\n5. Instruments');
  const iasErr = b.hud && b.air ? Math.abs(b.hud.ias - b.air.ias) : Infinity;
  check('HUD airspeed agrees with the flight model', iasErr < Math.max(3, b.air.ias * 0.06),
    b.hud ? `HUD ${(b.hud.ias * KMH).toFixed(0)} vs model ${(b.air.ias * KMH).toFixed(0)} km/h` : 'no HUD data');
  const altErr = b.hud ? Math.abs(b.hud.altBaro - b.py) : Infinity;
  check('HUD altitude agrees with the world position', altErr < 15,
    b.hud ? `HUD ${b.hud.altBaro.toFixed(0)} vs world ${b.py.toFixed(0)} m` : '');
  const gErr = b.hud && b.air ? Math.abs(b.hud.gLoad - b.air.gLoad) : Infinity;
  check('HUD g-load agrees with the flight model', gErr < 0.6,
    b.hud ? `HUD ${b.hud.gLoad.toFixed(2)} vs model ${b.air.gLoad.toFixed(2)} g` : '');
  const hudText = await page.evaluate(() => document.body.innerText || '');
  check('HUD shows flight instruments', /\bIAS\b|\bKM\/H\b|\bTAS\b/i.test(hudText),
    `${hudText.length} chars of HUD text`);

  // --- 6. does it actually fly? ---------------------------------------------
  // The default scheme is mouse aim, so the mouse is the primary control. Move
  // the pointer and the nose must follow it.
  console.log('\n6. Flight');

  /**
   * Flies the aeroplane back to something like level, the way a player would:
   * centre the reticle so the wing-leveller rolls out, then, if the nose is
   * still down, hold the reticle above the horizon until it comes back up.
   *
   * Every manoeuvre below has to start from a known attitude or the checks
   * measure the previous phase instead of this one.
   */
  const levelOff = async (settleMs = 2500) => {
    await page.mouse.move(800, 450, { steps: 8 });
    await sleep(settleMs);
    for (let i = 0; i < 12; i++) {
      const s = await sample();
      const pitch = s.air.pitchAngle * DEG;
      const ias = s.air.ias * KMH;
      // Manoeuvring speed matters as much as attitude: every check below is
      // about what the aeroplane can *do*, and a fighter mushing along at
      // 200 km/h cannot pull 3 g however good the controls are.
      if (pitch > -8 && pitch < 8 && ias > 300) break;
      // Reticle above the horizon to raise the nose, below it to drop it or to
      // trade altitude back for speed.
      const y = pitch <= -8 ? 380 : 520;
      await page.mouse.move(800, y, { steps: 6 });
      await sleep(1200);
      await page.mouse.move(800, 450, { steps: 6 });
      await sleep(900);
    }
  };

  // Throttle response, both directions. Read the commanded value as well as
  // the engine's: the model spools deliberately slowly, and a test that only
  // watched the shaft would call a working throttle broken.
  const tap = async (code) => {
    await page.keyboard.down(code);
    await sleep(120);
    await page.keyboard.up(code);
  };
  const cmdThrottle = () => page.evaluate(() => window.__game.get('input')?.throttle ?? -1);

  await tap('Digit9');                            // idle
  await sleep(2500);
  const idle = await sample();
  const idleCmd = await cmdThrottle();
  await tap('Digit0');                            // max
  await sleep(2500);
  const wide = await sample();
  const wideCmd = await cmdThrottle();
  check('throttle responds to input in both directions',
    idleCmd < 0.05 && wideCmd > 0.95 && idle.throttle < 0.3 && wide.throttle > 0.85,
    `commanded ${idleCmd.toFixed(2)}/${wideCmd.toFixed(2)},`
    + ` engine ${idle.throttle.toFixed(2)} -> ${wide.throttle.toFixed(2)}`);

  // Turn first, while the aeroplane is still in the cruise it spawned in.
  // Mouse aim holds a *sustained* deflection for as long as the reticle is off
  // the nose — exactly like War Thunder — so every one of these manoeuvres is
  // a held input, not a pulse, and each phase has to start from level flight.
  await levelOff(2500);
  const turn0 = await sample();
  await page.mouse.move(1180, 450, { steps: 10 });
  await sleep(2200);
  const turnMid = await sample();
  await sleep(1800);
  const turn1 = await sample();
  const dHdg = Math.abs(wrapDeg((turn1.heading - turn0.heading) * DEG));
  check('the aircraft banks and turns when told to',
    dHdg > 25 && Math.abs(turnMid.air.rollAngle * DEG) > 15 && turnMid.air.gLoad > 1.3,
    `heading changed ${dHdg.toFixed(0)}°, bank ${(turnMid.air.rollAngle * DEG).toFixed(0)}°,`
    + ` ${turnMid.air.gLoad.toFixed(1)} g`);

  // Climb: hold the reticle above the horizon for a moment, not a full loop.
  await levelOff();
  const climb0 = await sample();
  await page.mouse.move(800, 375, { steps: 8 });
  await sleep(2600);
  const climb1 = await sample();
  // Measured as a *change*: the phase may start from a shallow descent, and
  // "raised the nose 20° and turned 30 m/s of sink into 30 m/s of climb" is the
  // physical claim being tested, not "gained N metres".
  const dPitch = (climb1.air.pitchAngle - climb0.air.pitchAngle) * DEG;
  const dVs = climb1.air.vertSpeed - climb0.air.vertSpeed;
  check('the aircraft climbs when told to',
    dPitch > 12 && dVs > 18 && climb1.air.vertSpeed > 4 && climb1.air.health > 0,
    `pitch ${(climb0.air.pitchAngle * DEG).toFixed(0)}° -> ${(climb1.air.pitchAngle * DEG).toFixed(0)}°,`
    + ` VS ${climb0.air.vertSpeed.toFixed(0)} -> ${climb1.air.vertSpeed.toFixed(0)} m/s`);

  // Dive and accelerate: nose down, full power.
  await levelOff();
  const dive0 = await sample();
  // A short, shallow push. Mouse aim commands a *sustained* pitch rate, so a
  // big deflection held for five seconds is not a dive — it is a bunt over the
  // vertical and out the other side.
  await page.mouse.move(800, 525, { steps: 10 });
  await sleep(2600);
  const dive1 = await sample();
  check('the aircraft dives and accelerates',
    dive1.speed > dive0.speed + 3
    && dive1.air.vertSpeed < dive0.air.vertSpeed - 10
    && dive1.air.pitchAngle < dive0.air.pitchAngle,
    `${(dive0.speed * KMH).toFixed(0)} -> ${(dive1.speed * KMH).toFixed(0)} km/h,`
    + ` VS ${dive0.air.vertSpeed.toFixed(0)} -> ${dive1.air.vertSpeed.toFixed(0)} m/s`);

  // Keyboard axes, independently of mouse aim.
  await levelOff();
  const roll0 = await sample();
  await page.keyboard.down('KeyA');
  await sleep(1800);
  const roll1 = await sample();
  await page.keyboard.up('KeyA');
  check('keyboard roll authority is real',
    Math.abs(wrapDeg((roll1.air.rollAngle - roll0.air.rollAngle) * DEG)) > 12,
    `bank ${(roll0.air.rollAngle * DEG).toFixed(0)}° -> ${(roll1.air.rollAngle * DEG).toFixed(0)}°`);

  // Releasing everything must not leave the aeroplane departed: wings come
  // back level, it stays flyable and it does not tumble.
  await levelOff(4000);
  const recovered = await sample();
  check('stays under control when the stick is released',
    Math.abs(recovered.air.rollAngle * DEG) < 50 && recovered.air.health > 0
    && recovered.air.ias * KMH > 120 && recovered.air.agl > 50,
    `bank ${(recovered.air.rollAngle * DEG).toFixed(0)}°,`
    + ` pitch ${(recovered.air.pitchAngle * DEG).toFixed(0)}°,`
    + ` IAS ${(recovered.air.ias * KMH).toFixed(0)} km/h, AGL ${recovered.air.agl.toFixed(0)} m`);
  await page.screenshot({ path: `${tag}-04-flying.png` });

  // --- 7. weapons ------------------------------------------------------------
  console.log('\n7. Weapons');
  const projBefore = await page.evaluate(COUNT_PROJECTILES);
  let projPeak = 0;
  let armed = false;
  // Two bursts. The first also serves to put the pointer over the canvas and
  // take the controls, which a player does before they ever pull the trigger.
  for (let burst = 0; burst < 2 && projPeak <= projBefore; burst++) {
    await page.mouse.move(800, 450, { steps: 4 });
    await page.mouse.down({ button: 'left' });
    for (let i = 0; i < 12; i++) {
      await sleep(140);
      projPeak = Math.max(projPeak, await page.evaluate(COUNT_PROJECTILES));
      armed = armed || await page.evaluate(() => (window.__game.get('input')?.frame?.bits & 1) !== 0);
    }
    await page.mouse.up({ button: 'left' });
    await sleep(400);
  }
  check('firing produces tracers in the world', projPeak > projBefore,
    `${projBefore} -> ${projPeak} projectiles, trigger bit ${armed ? 'set' : 'NEVER SET'}`);
  await page.screenshot({ path: `${tag}-05-firing.png` });

  const opponents = await page.evaluate(() => {
    const g = window.__game;
    let n = 0;
    for (const e of g.entities.values()) {
      if (e.kind === 1 && e.id !== g.localEntityId) n++;
    }
    return n;
  });
  // The offline sandbox flies a six-ship. The authoritative server has no bots
  // yet, so a solo online player has nothing to shoot at — a content gap, not a
  // failure of this build, and asserting it here would only ever be red.
  if (mode === 'offline') {
    check('there is something to fight', opponents > 0, `${opponents} other aircraft`);
  } else {
    console.log(`  \x1b[33mNOTE\x1b[0m  ${opponents} other aircraft online (server has no AI)`);
  }

  // --- 8. camera -------------------------------------------------------------
  console.log('\n8. Camera');
  const camBefore = await sample();
  await page.keyboard.press('KeyC');
  await sleep(1400);
  const camAfter = await sample();
  const camMoved = Math.hypot(camAfter.camX - camBefore.camX, camAfter.camY - camBefore.camY,
    camAfter.camZ - camBefore.camZ);
  check('camera cycles with C', camMoved > 0.5, `camera moved ${camMoved.toFixed(1)} m`);
  await page.keyboard.press('KeyC');
  await sleep(1000);
  await page.screenshot({ path: `${tag}-06-camera.png` });

  // --- 9. stability ----------------------------------------------------------
  console.log('\n9. Stability');
  await sleep(5000);
  const final = await sample();
  const finite = !!final && [final.px, final.py, final.pz, final.speed, final.air.ias, final.air.gLoad]
    .every(Number.isFinite);
  check('state stays finite after sustained play', finite,
    final ? `alt ${final.py.toFixed(0)} m, ${(final.speed * KMH).toFixed(0)} km/h` : '');
  check('the aeroplane survived being flown', !!final && final.air.health > 0 && final.air.agl > 0,
    final ? `health ${final.air.health.toFixed(2)}, AGL ${final.air.agl.toFixed(0)} m` : '');
  check('airspeed still plausible after manoeuvring',
    !!final && final.air.ias * KMH > 100 && final.air.ias * KMH < 900,
    final ? `IAS ${(final.air.ias * KMH).toFixed(0)} km/h` : '');

  if (mode === 'online') {
    const p = final?.pred;
    // Hard corrections mean the server and the client disagree by more than
    // 8 m — that is what rubber-banding looks like from the inside.
    const hardRate = p && p.corrections > 20 ? p.hard / p.corrections : 0;
    check('prediction is not fighting the server', !!p && hardRate < 0.05,
      p ? `${p.hard} hard of ${p.corrections} corrections, max ${p.maxErr.toFixed(1)} m` : '');
  }

  // --- 10. ground attack -----------------------------------------------------
  // Offline only: the ground installations are built by the world subsystem
  // from the map seed and live in the client's world, so a bombing run is only
  // resolvable on the path that owns them.
  if (mode === 'offline') await groundAttack(page, tag, check);

  const stats = await page.evaluate(() => window.__game?.stats ?? null);
  check('frame rate holds up', (stats?.fps ?? 0) >= 45,
    `${stats?.fps ?? 0} fps, ${stats?.drawCalls ?? 0} draw calls`);

  // More than the initial load means something reloaded the tab underneath the
  // test — an HMR full reload, or the page navigating away. Either invalidates
  // everything measured after it.
  check('the page never reloaded during the run', navigations.length <= 1,
    `${navigations.length} navigations`);

  const real = errors.filter((e) => !/ws:\/\/|WebSocket/.test(e));
  check('no uncaught runtime errors', real.length === 0, real.slice(0, 3).join(' | '));

  await page.screenshot({ path: `${tag}-07-final.png` });
  await page.close();
}

/**
 * A complete air-to-ground sortie: rearm in the hangar, fly a dive-bombing
 * pass on a real ground installation, release, and watch the bomb fall.
 *
 * The parts that matter and that nothing else covers:
 *
 *  - the loadout is chosen through the hangar, not injected;
 *  - carrying it actually changes the aeroplane (mass and drag), and dropping
 *    it gives most of that back;
 *  - the release is the real 'DropBomb' input bit from a real key press;
 *  - the store is a real entity that falls *ballistically* — accelerating
 *    downward while keeping the forward throw it inherited — rather than being
 *    teleported at the ground;
 *  - and something is destroyed at the end of it.
 *
 * The run-in is set up with the same debug placement the screenshot framings
 * use. Flying four kilometres to a convoy in real time would add a minute to
 * every run and would be testing the terrain, not the ordnance.
 */
async function groundAttack(page, tag, check) {
  console.log('\n10. Ground attack');

  // --- rearm --------------------------------------------------------------
  await page.keyboard.press('Escape');
  await sleep(700);
  const toHangar = await clickButton(page, 'button.ct-navitem', 'change aircraft');
  const inHangar = toHangar && await waitForScreen(page, 'hangar', 6000);
  check('the hangar is reachable from the cockpit', inHangar,
    inHangar ? '' : `screen is "${await page.evaluate(SCREEN)}"`);
  if (!inHangar) return;

  const picked = await clickButton(page, '#ct-hangar button.ct-btn.is-ghost.is-sm', '250 lb');
  check('a bomb loadout can be selected in the hangar', picked);
  await sleep(500);
  await page.screenshot({ path: `${tag}-08-loadout.png` });

  await clickButton(page, 'button.ct-btn.is-primary', 'deploy');
  const flying = await waitForScreen(page, 'flight', 8000);
  if (!flying) { check('deploying with stores puts the player back in the air', false); return; }
  await page.mouse.move(800, 450, { steps: 6 });
  await sleep(3500);

  const ORD = () => window.__game?.get?.('flight')?.ordnanceState ?? null;
  const armed = await page.evaluate(ORD);
  check('the aircraft deploys carrying the chosen stores',
    !!armed && armed.loadout !== 'clean' && armed.bombs === 2,
    armed ? `loadout "${armed.loadout}", ${armed.bombs} bombs` : 'no ordnance state');
  check('stores are felt by the flight model as mass and drag',
    !!armed && armed.extraMass > 200 && armed.extraDrag > 0.05,
    armed ? `+${armed.extraMass.toFixed(0)} kg, +${armed.extraDrag.toFixed(3)} m² CdA` : '');

  const hudText = await page.evaluate(() => document.body.innerText || '');
  check('the HUD shows an ordnance readout', /STORES/i.test(hudText) && /2\/2/.test(hudText),
    /STORES/i.test(hudText) ? 'STORES panel present' : 'no STORES panel');

  // --- set up the run -----------------------------------------------------
  // A short, steep attack from 900 m out and 330 m up: a 20° dive, four
  // seconds of run-in and a release at about 250 m. That is a real
  // fighter-bomber pass and it is deliberately *short*, because a three-
  // kilometre approach spends fifteen seconds accumulating drift that has
  // nothing to do with the ordnance and everything to do with how well an
  // untended Spitfire holds a heading.
  const setup = await page.evaluate(() => {
    const g = window.__game;
    const ord = g.get('flight').ordnanceState;
    // A soft-skinned lorry rather than a dug-in gun: it is the target class a
    // 250 lb bomb is meant for.
    const t = ord.targets.find((x) => x.alive && x.kind === 'truck')
      ?? ord.targets.find((x) => x.alive && x.kind === 'aa');
    if (!t) return null;
    const D = 900, H = 330;
    const heading = Math.PI * 0.25;
    const place = (x, y, z) => g.bus.emit('debug:place', {
      // 'debug:place' takes the flight model's Euler convention, in which a
      // POSITIVE pitch puts the nose down (see qFromEuler in shared/math).
      x, y, z, heading, pitch: Math.atan2(H, D), bank: 0, speed: 150, opponent: null,
    });
    const x0 = t.x - Math.sin(heading) * D;
    const z0 = t.z - Math.cos(heading) * D;
    place(x0, t.y + H, z0);
    return {
      id: t.id, kind: t.kind, x: t.x, y: t.y, z: t.z, hp: t.hp,
      heading, x0, z0, y0: t.y + H,
    };
  });
  check('there is a ground target to attack', !!setup,
    setup ? `${setup.kind} #${setup.id}, ${setup.hp} hp` : 'no live ground targets');
  if (!setup) return;
  await sleep(900);

  // One lateral correction, taken from the game's own impact solution: shift
  // the whole run-in sideways so the ground track passes over the target. This
  // is the harness standing in for the fifteen seconds of gentle S-turning a
  // pilot does on the way in, and it is the only part of the pass that is not
  // flown — the approach, the release and everything after it are real.
  const aim = await page.evaluate((tgt) => {
    const g = window.__game;
    const o = g.get('flight').ordnanceState;
    if (!o.solution) return null;
    // Across-track unit vector, horizontal and perpendicular to the run-in.
    const ax = Math.cos(tgt.heading), az = -Math.sin(tgt.heading);
    const across = (tgt.x - o.solution.x) * ax + (tgt.z - o.solution.z) * az;
    g.bus.emit('debug:place', {
      x: tgt.x0 + ax * across, y: tgt.y0, z: tgt.z0 + az * across,
      heading: tgt.heading, pitch: Math.atan2(330, 900), bank: 0, speed: 150,
      opponent: null,
    });
    return { across };
  }, setup);
  check('the bombsight produces a usable solution on the run-in', !!aim,
    aim ? `across-track correction ${aim.across.toFixed(0)} m` : 'no solution');
  await sleep(500);

  // --- fly the pass and pickle ---------------------------------------------
  // The pipper sits a fixed distance ahead of the aeroplane and the target
  // walks back through it. Release on the crossing.
  let best = 1e9;
  let released = false;
  let sightSeen = false;
  let shotTaken = false;
  let prevAlong = Infinity;
  for (let i = 0; i < 160 && !released; i++) {
    const s = await page.evaluate((tgt) => {
      const g = window.__game;
      const o = g?.get?.('flight')?.ordnanceState;
      const node = document.getElementById('ct-bombsight');
      const shown = !!node && getComputedStyle(node).display !== 'none';
      if (!o || !o.solution) return { shown, d: null };
      const ex = tgt.x - o.solution.x, ez = tgt.z - o.solution.z;
      return {
        shown,
        d: Math.hypot(ex, ez),
        // Positive while the target is still beyond the pipper.
        along: ex * Math.sin(tgt.heading) + ez * Math.cos(tgt.heading),
      };
    }, setup);
    sightSeen = sightSeen || s.shown;
    if (s.d !== null) {
      if (s.d < 220 && !shotTaken) {
        shotTaken = true;
        await page.screenshot({ path: `${tag}-09-bombrun.png` });
      }
      best = Math.min(best, s.d);
      if (prevAlong > 0 && s.along <= 0) {
        await page.keyboard.press('KeyV');
        released = true;
      }
      prevAlong = s.along;
    }
    await sleep(40);
  }
  check('the bombsight is flown onto the target', best < 20,
    `closest predicted impact ${best.toFixed(0)} m from the target`);
  check('the impact indicator is drawn on the way in', sightSeen,
    sightSeen ? 'pipper visible during the run' : 'pipper never shown');
  // Pull off the target rather than following the bomb into the ground.
  await page.mouse.move(800, 360, { steps: 4 });

  // One frame for the release to be consumed by the flight step.
  await sleep(300);
  const after = await page.evaluate(ORD);
  check('pressing the release drops a store',
    !!after && after.bombs === 1 && after.inFlight >= 1,
    after ? `${after.bombs} left, ${after.inFlight} in flight` : '');
  check('releasing gives the performance back',
    !!after && !!armed && after.extraMass < armed.extraMass - 100
    && after.extraDrag < armed.extraDrag,
    after ? `${after.extraMass.toFixed(0)} kg / ${after.extraDrag.toFixed(3)} m² CdA` : '');

  // --- the fall -----------------------------------------------------------
  // Sample the bomb entity over the first second of its fall: a store that is
  // integrated properly gains downward speed and keeps its forward throw.
  const track = [];
  for (let i = 0; i < 20; i++) {
    const b = await page.evaluate(() => {
      for (const e of window.__game.entities.values()) {
        if (e.kind === 3) return { x: e.px, y: e.py, z: e.pz, vy: e.vy, sp: Math.hypot(e.vx, e.vy, e.vz) };
      }
      return null;
    });
    if (b) track.push(b);
    await sleep(70);
  }
  const t0 = track[0], t1 = track[track.length - 1];
  check('the store exists in the world as a falling entity', track.length >= 4,
    `${track.length} samples`);
  check('it falls ballistically — accelerating down, still going forward',
    track.length >= 4 && t1.vy < t0.vy - 4 && t1.y < t0.y
    && Math.hypot(t1.x - t0.x, t1.z - t0.z) > 60,
    track.length >= 4
      ? `VS ${t0.vy.toFixed(0)} -> ${t1.vy.toFixed(0)} m/s,`
        + ` throw ${Math.hypot(t1.x - t0.x, t1.z - t0.z).toFixed(0)} m`
      : 'no track');

  // --- the crater ---------------------------------------------------------
  let hit = null;
  for (let i = 0; i < 160; i++) {
    hit = await page.evaluate((tgt) => {
      const o = window.__game?.get?.('flight')?.ordnanceState;
      const t = o?.targets.find((x) => x.id === tgt.id);
      return t ? { hp: t.hp, alive: t.alive, inFlight: o.inFlight } : null;
    }, setup);
    if (hit && (!hit.alive || hit.hp < setup.hp)) break;
    await sleep(200);
  }
  check('the bomb detonates and destroys the target',
    !!hit && (!hit.alive || hit.hp < setup.hp),
    hit ? `${setup.kind} #${setup.id}: ${setup.hp} -> ${hit.hp.toFixed(0)} hp, alive=${hit.alive}` : '');
  await page.screenshot({ path: `${tag}-10-impact.png` });
}

async function finish(browser) {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n\x1b[1m${passed}/${results.length} checks passed\x1b[0m`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - [${f.suite}] ${f.name}${f.detail ? `  (${f.detail})` : ''}`);
  }
  console.log(`\nScreenshots in ${OUT}/\n`);
  await browser.close();
  devProc?.kill();
  gameProc?.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  devProc?.kill();
  gameProc?.kill();
  process.exit(1);
});
