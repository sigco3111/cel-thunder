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
/**
 * The harness runs its own *game* server too, on its own port, for the same
 * reason it runs its own web server: a developer's server on :8791 has a
 * different match already in progress, a different roster and — importantly —
 * no 'CT_DEBUG_PLACE', which is what lets section 10 fly a repeatable bombing
 * run online instead of spending a minute of every run in transit.
 */
const GAME_PORT = 8792;
const GAME_SERVER = `http://localhost:${GAME_PORT}/health`;
const OUT = 'shots/playtest';

/** Pointing the client at a dead socket is how we force the offline sandbox. */
const OFFLINE_URL = `${WEB}/?server=ws://127.0.0.1:8799/ws`;
const ONLINE_URL = `${WEB}/?server=ws://127.0.0.1:${GAME_PORT}/ws`;

const KMH = 3.6;

/**
 * Aircraft the match is supposed to have airborne, both paths.
 *
 * Ten a side on the server ('DEFAULT_MATCH.rosterPerTeam'), twenty entries in
 * the offline sandbox's own roster. Asserted rather than merely observed: a
 * roster that silently collapses is the difference between a game and a
 * demo, and "there is at least one other aeroplane" cannot tell them apart.
 */
const EXPECTED_ROSTER = 20;
/**
 * How far below the roster the count may sit at the moment of measurement.
 *
 * Not slack for a broken backfill — slack for the respawn queue. A death costs
 * an aeroplane for 'respawnDelay' seconds, and by the time this runs the AI has
 * been fighting for a couple of minutes, so two or three of the roster being
 * mid-respawn is the normal, healthy state.
 */
const ROSTER_SLACK = 5;
const DEG = 180 / Math.PI;

/**
 * Half the spread between the roll demanded for an equal-and-opposite pair of
 * tiny aim nudges — i.e. how much roll the *error itself* is worth, with any
 * standing wing-leveller term cancelled out.
 */
const nudgeSpan = (d) => (d.nudgeR.rollErr - d.nudgeL.rollErr) / 2;

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
      gameProc = spawn('npx', ['tsx', 'server/index.ts'], {
        stdio: 'ignore',
        env: { ...process.env, PORT: String(GAME_PORT), CT_DEBUG_PLACE: '1' },
      });
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
    if (haveServer) await guarded(browser, 'online', ONLINE_URL);
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

  /**
   * Never returns null: an aircraft that vanished is a failure, not a crash.
   *
   * "Vanished" has to mean *stayed* vanished, though. Being shot down destroys
   * the entity and the replacement arrives a respawn delay later, so in a
   * twenty-ship match there is a routine several-second window in which the
   * player has no aeroplane in the table at all. Throwing on the first empty
   * read aborted the whole suite mid-run — 'the player aircraft disappeared
   * from the world' — for something that is simply what dying looks like. So
   * it waits out a respawn before giving up.
   */
  const sample = async () => {
    for (let i = 0; i < 60; i++) {
      const s = await page.evaluate(SAMPLE);
      if (s) return s;
      await sleep(250);
    }
    throw new Error('the player aircraft disappeared from the world');
  };

  /**
   * The entity the player is currently flying.
   *
   * A respawn issues a *new* id, which is the only reliable signal that the
   * aeroplane under a measurement was replaced — and with it every held key and
   * mouse button, because those live in the input subsystem and it resets on
   * spawn. Several checks below are only meaningful across one aeroplane's
   * life, so they compare this before and after.
   */
  const entityId = () => page.evaluate(() => window.__game.localEntityId);

  // --- 1. boot ---------------------------------------------------------------
  console.log('\n1. Boot');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const booted = await page.waitForFunction('window.__ready === true', { timeout: 90000 })
    .then(() => true).catch(() => false);
  check('game reaches ready state', booted);
  if (!booted) { await page.close(); return; }

  // Record every pointer-lock outcome from here on. A refused capture used to
  // be completely silent — the player was left flying an aeroplane that was
  // chasing a cursor they did not know was uncaptured — so the refusals are
  // now counted and reported rather than swallowed.
  await page.evaluate(() => {
    window.__lockEvents = [];
    document.addEventListener('pointerlockerror', () => window.__lockEvents.push('error'));
    document.addEventListener('pointerlockchange', () => window.__lockEvents.push(
      document.pointerLockElement ? `lock:${document.pointerLockElement.tagName}` : 'unlock'));
  });

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

  // --- 2b. taking the controls ----------------------------------------------
  //
  // Reported by the player as "the mouse is always not focused on the game".
  // Chromium refuses 'requestPointerLock' outright when the document does not
  // have OS focus, which is the state a player is in every time they alt-tab
  // back and click — and the refusal was silent, so from the cockpit it looked
  // like clicking simply did nothing.
  console.log('\n2b. Taking the controls');

  // Nothing may be sitting on top of the canvas in flight. A screen overlay
  // left mounted swallows every click, the lock is never even requested, and
  // no amount of clicking can recover it.
  const centreEl = await page.evaluate(() => {
    const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    const canvas = window.__game?.renderer?.domElement;
    return {
      isCanvas: el === canvas,
      tag: el ? el.tagName + (el.className ? `.${String(el.className).split(' ')[0]}` : '') : 'null',
      focusable: canvas?.getAttribute('tabindex'),
    };
  });
  check('nothing covers the canvas in flight — the click that captures can land',
    centreEl.isCanvas, `element at screen centre is ${centreEl.tag}`);
  check('the canvas is focusable, so the browser will lock to it',
    centreEl.focusable !== null && centreEl.focusable !== undefined,
    `tabindex=${centreEl.focusable}`);

  // Click the way a player does when the capture does not take: once, then
  // again. Deploy has already made one request from inside its own gesture.
  await page.mouse.move(800, 450, { steps: 4 });
  await page.mouse.down(); await page.mouse.up();
  await sleep(500);
  await page.mouse.down(); await page.mouse.up();
  await sleep(800);

  const lock0 = await page.evaluate(() => {
    const m = window.__game?.get?.('input')?.mouse;
    return m ? {
      locked: m.locked, denied: m.lockDenied, requests: m.lockRequests,
      errors: m.lockErrors, needsFocus: m.lockNeedsFocus,
      hasFocus: document.hasFocus(),
      active: document.activeElement?.tagName ?? 'null',
      events: window.__lockEvents.slice(),
    } : null;
  });
  check('clicking the game asks the browser for the mouse',
    !!lock0 && lock0.requests > 0,
    lock0 ? `${lock0.requests} request(s), ${lock0.errors} refused, document focus=${lock0.hasFocus}` : 'no mouse device');
  check('the canvas takes DOM focus when the player clicks it',
    !!lock0 && lock0.active === 'CANVAS', lock0 ? `activeElement=${lock0.active}` : '');

  // The capture itself cannot be *asserted* here: Chromium will not grant
  // pointer lock to a window that does not have OS focus, and under automation
  // it usually does not. What must hold either way is that the player ends up
  // with a working control scheme rather than an aeroplane that ignores them —
  // captured, or fallen back to the cursor and saying so.
  if (lock0?.locked) {
    check('the pointer is captured', true, `events: ${lock0.events.join(', ')}`);
  } else {
    console.log(`  \x1b[33mNOTE\x1b[0m  this environment refused pointer lock`
      + ` (${lock0?.errors} error(s), events: ${lock0?.events.join(', ') || 'none'});`
      + ` the cursor fallback is what is being tested below`);
    check('a refused capture falls back to the cursor instead of ignoring the player',
      !!lock0 && lock0.denied && lock0.errors > 0,
      lock0 ? `denied=${lock0.denied} after ${lock0.errors} refusal(s)` : '');
  }

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
  //
  // Re-flown if the aeroplane was replaced under us. A held key is state in the
  // *input subsystem*, and a respawn resets it — so a pilot who is shot down
  // during the 1.8 s measurement comes back in a fresh aeroplane with the
  // stick centred, and the measurement reads "no roll authority" about a
  // controller that is working perfectly. With a full twenty-ship roster that
  // stopped being a remote possibility, so it is handled rather than hoped
  // about. Bounded to one retry: a loop that retried until it liked the answer
  // would not be testing anything.
  let rollOk = false;
  let roll0, roll1;
  for (let attempt = 0; attempt < 2 && !rollOk; attempt++) {
    await levelOff();
    const bornBefore = await entityId();
    roll0 = await sample();
    await page.keyboard.down('KeyA');
    await sleep(1800);
    roll1 = await sample();
    await page.keyboard.up('KeyA');
    rollOk = (await entityId()) === bornBefore;
    if (!rollOk && attempt === 0) console.log('  ..  roll sample lost its aeroplane mid-measurement — re-flying');
  }
  check('keyboard roll authority is real',
    Math.abs(wrapDeg((roll1.air.rollAngle - roll0.air.rollAngle) * DEG)) > 12,
    `bank ${(roll0.air.rollAngle * DEG).toFixed(0)}° -> ${(roll1.air.rollAngle * DEG).toFixed(0)}°`
    + (rollOk ? '' : ' [aeroplane replaced mid-measurement]'));

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

  // --- 6b. hands off ---------------------------------------------------------
  //
  // THE regression test for what the player reported as "atm plane is jittery
  // and moving around". With the capture held and the mouse untouched, the
  // aeroplane must fly straight and level, indefinitely.
  //
  // The old flight director could not. Its roll law asked for 'atan2(x, y)' of
  // the pointing error — which is ±90° for a sideways error *however small* —
  // and the ramp meant to suppress that near zero reached full authority at
  // 1.1° of error, so in cruise the director sat on the steep part of it and
  // half a degree of pointing error commanded full aileron. Measured before the
  // fix, hands off for 12 s: bank swinging ±7°, aileron slamming between ±0.43,
  // roll rates of 60°/s, forever. After: ±1.4° of bank and ±0.03 of aileron.
  //
  // It is not enough for the wings to be level: hands off has to be a true
  // steady state, and "the attitude is held" is not one. A second defect hid
  // behind that distinction. With the reticle exactly on the nose the outer
  // loop asks for nothing at all, which leaves the elevator free — and a
  // fighter at full throttle with a free elevator pitches slowly up. Measured
  // uncaptured, hands off, twelve seconds: the nose walked from −3° to −11°,
  // the aeroplane climbed 187 m and the airspeed decayed 463 → 433 km/h,
  // monotonically, on its way to a stall. So this measures attitude, altitude
  // AND airspeed, for thirty seconds, not ten.
  //
  // Two things are stubbed for the duration, and both of them are the *setup*
  // rather than the thing under test:
  //
  //   'mouse.locked' is forced, for the same reason the check further down
  //   clears 'lockDenied'. Chromium will not grant pointer lock to a window
  //   without OS focus and the harness never has it, yet the relative path is
  //   the one a player flies, the one the roll bug lived in, and the only one
  //   where the reticle is a world direction that can drift off the nose.
  //
  //   'drain' is neutralised, because hands off has to mean hands off. The
  //   harness runs headed with the OS cursor over the window, and a single
  //   stray pointer event is a real command: measured, one 600 px event in an
  //   otherwise flat 60 s trace rolled the aeroplane to 24° of bank and moved
  //   it 26 m — correct behaviour, and nothing to do with what is being tested.
  //   Swallowed events are counted and reported so this can never quietly hide
  //   an input the test did not intend to make.
  //
  // The measurement is also *guarded against being shot at*. With a full
  // twenty-ship roster the aeroplane is usually inside somebody's gunsight by
  // the time this section runs, and a burst through the wing produces exactly
  // the trace this check exists to reject — 35° of bank and 63° of roll demand
  // from a controller that is behaving correctly and is busy recovering from
  // damage. Blaming the director for that is a false negative that tells you
  // nothing, and loosening the thresholds to accommodate it would throw away
  // the only check that catches the real roll limit cycle. So the sample
  // records whether the airframe took a hit while it was being measured, and a
  // disturbed sample is re-flown rather than scored.
  await levelOff(3000);
  const measureHandsOff = () => page.evaluate(async () => {
    const input = window.__game.get('input');
    const m = input.mouse;
    const wasLocked = m.locked;
    const realDrain = m.drain.bind(m);
    let swallowed = 0;
    m.drain = (out) => {
      realDrain(out);
      if (out.dx || out.dy) swallowed++;
      out.dx = 0; out.dy = 0;
    };
    m.locked = true;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const bankOf = () => Math.atan2(input.view.right.y, input.view.up.y) * 57.2958;
    const pitchOf = () => Math.asin(Math.max(-1, Math.min(1, input.view.forward.y))) * 57.2958;
    const air = () => window.__game.get('flight').airData;
    // Four seconds for the director to finish whatever attitude the previous
    // phase left, then thirty seconds of measurement.
    await wait(4000);
    const a0 = air();
    const alt0 = a0.altitude;
    const tas0 = a0.tas * 3.6;
    const pitch0 = pitchOf();
    const me = () => window.__game.entities.get(window.__game.localEntityId);
    const dmg0 = me() ? me().damage : 0;
    const hp0 = me() ? me().health : 1;
    // The entity id, because a death is invisible in damage and health alone:
    // the replacement aeroplane comes back undamaged at full health, which is
    // exactly what an untouched one looks like. Only the id changes.
    const id0 = window.__game.localEntityId;
    let disturbed = '';
    let peakBank = 0;
    let peakDemand = 0;
    let peakPitchDrift = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 30000) {
      await wait(100);
      const e = me();
      // Anything that hits the aeroplane invalidates the sample: what is being
      // measured is the director holding a trimmed aeroplane, and a holed one
      // is not that.
      if (window.__game.localEntityId !== id0) disturbed = disturbed || 'was shot down and respawned';
      else if (!e) disturbed = disturbed || 'the aircraft left the world';
      else if (e.damage !== dmg0) disturbed = disturbed || 'took battle damage';
      else if (e.health < hp0 - 0.001) disturbed = disturbed || 'was hit';
      peakBank = Math.max(peakBank, Math.abs(bankOf()));
      peakPitchDrift = Math.max(peakPitchDrift, Math.abs(pitchOf() - pitch0));
      // The OUTER loop's output, in degrees of roll asked for. Deliberately not
      // the aileron: a slow aeroplane has little roll authority, so the inner
      // loop legitimately saturates the surface to make a modest rate, and a
      // check on the surface would read a correct controller as a broken one.
      // This is also the exact quantity the roll bug lived in.
      peakDemand = Math.max(peakDemand, Math.abs(input.aim.rollError) * 57.2958);
    }
    const a = air();
    const out = {
      bank: bankOf(), peakBank, peakDemand, peakPitchDrift,
      alt0, alt1: a.altitude, tas0, tas1: a.tas * 3.6,
      pitch0, pitch1: pitchOf(),
      theta: input.aim.theta,
      demand: input.aim.rollError * 57.2958,
      roll: input.frame.roll, pitch: input.frame.pitch, yaw: input.frame.yaw,
      vs: a.vertSpeed, spin: a.spinning, swallowed, disturbed,
    };
    m.locked = wasLocked;
    m.drain = realDrain;
    return out;
  });

  // One re-fly if the first sample was shot at. Deliberately bounded: a
  // measurement that retried until it liked the answer would test nothing, so
  // a second disturbed sample is scored as-is and says why in the detail.
  let handsOff = await measureHandsOff();
  if (handsOff.disturbed) {
    console.log(`  ..  hands-off sample discarded (${handsOff.disturbed}) — re-flying`);
    await levelOff(3000);
    handsOff = await measureHandsOff();
  }
  const disturbedNote = handsOff.disturbed ? ` [DISTURBED: ${handsOff.disturbed}]` : '';
  const dAlt = handsOff.alt1 - handsOff.alt0;
  const dTas = handsOff.tas1 - handsOff.tas0;
  const dNose = handsOff.pitch1 - handsOff.pitch0;
  check('hands off for 30 s, the aeroplane flies straight and level',
    Math.abs(handsOff.bank) < 5 && handsOff.peakBank < 10,
    `bank ${handsOff.bank.toFixed(1)}° (peak ${handsOff.peakBank.toFixed(1)}°),`
    + ` ${handsOff.swallowed} stray pointer event(s) swallowed${disturbedNote}`);
  // Before the fix this sat at ±17° of demand with excursions past 57°, which
  // is what saturated the ailerons and produced the roll limit cycle.
  check('hands off, nothing is asking the aeroplane to roll',
    Math.abs(handsOff.demand) < 4 && handsOff.peakDemand < 8,
    `roll demand ${handsOff.demand.toFixed(2)}°, peak ${handsOff.peakDemand.toFixed(2)}°`
    + ` (aileron ${handsOff.roll.toFixed(3)})${disturbedNote}`);
  check('hands off for 30 s, the nose stays where it is',
    Math.abs(dNose) < 3 && handsOff.peakPitchDrift < 5,
    `pitch ${handsOff.pitch0.toFixed(1)}° -> ${handsOff.pitch1.toFixed(1)}°`
    + ` (drift ${dNose >= 0 ? '+' : ''}${dNose.toFixed(1)}°, peak ${handsOff.peakPitchDrift.toFixed(1)}°)${disturbedNote}`);
  check('hands off for 30 s, the aeroplane holds its altitude',
    Math.abs(dAlt) < 50 && Math.abs(handsOff.vs) < 4,
    `${handsOff.alt0.toFixed(0)} -> ${handsOff.alt1.toFixed(0)} m`
    + ` (${dAlt >= 0 ? '+' : ''}${dAlt.toFixed(0)} m in 30 s), VS ${handsOff.vs.toFixed(1)} m/s${disturbedNote}`);
  // Asymmetric, and physically so. Losing speed hands-off is how a beginner
  // ends up stalled and is the failure this exists to catch; gaining a little
  // is the aeroplane settling at the speed a wide-open throttle buys it in
  // level flight, which is where it spawns short of. Measured after the fix:
  // +16 km/h over the first 30 s from a cold spawn, converging on +5 per 30 s
  // thereafter. Before it, −30 km/h and still falling.
  check('hands off for 30 s, the aeroplane does not bleed speed',
    dTas > -12 && dTas < 28,
    `TAS ${handsOff.tas0.toFixed(0)} -> ${handsOff.tas1.toFixed(0)} km/h`
    + ` (${dTas >= 0 ? '+' : ''}${dTas.toFixed(0)} km/h in 30 s)${disturbedNote}`);

  // --- 6c. zero input means zero command ------------------------------------
  //
  // The end-to-end check above can only ever say "it settled". This one goes at
  // the flight director directly and says why: with the reticle exactly on the
  // nose it must ask for nothing at all, and with the reticle a fraction of a
  // degree off it must ask for a fraction of the aileron — not, as it used to,
  // all of it.
  const director = await page.evaluate(() => {
    const input = window.__game.get('input');
    const aim = input.aim;
    const view = input.view;
    const DEG = 57.2958;
    const V = view.right.constructor;
    const right = new V(); const up = new V(); const back = new V();
    window.__game.camera.matrixWorld.extractBasis(right, up, back);

    // The aircraft cannot respond to these synthetic steps — the view is
    // frozen — so its live body rates are zeroed for the duration. Otherwise
    // the inner rate loop spends every step fighting a rotation that never
    // stops and winds its integrator into the answer, which measures the
    // harness rather than the director.
    const w = view.omega;
    const saved = { x: w.x, y: w.y, z: w.z };
    w.set(0, 0, 0);
    // Enough steps for the outer loop's rate-derivative term to wash out, few
    // enough that the inner integrator stays where it starts.
    const settle = () => { for (let i = 0; i < 8; i++) aim.update(view, 1 / 60, 0, 0, 0); return aim.out; };
    // What the outer loop asked for, in degrees of roll. This is the quantity
    // that was broken: it used to be ±57° for any sideways error at all.
    const demand = () => ({
      roll: aim.out.roll,
      rollErr: aim.rollError * DEG,
      bank: aim.bankDemand * DEG,
      theta: aim.theta * DEG,
    });

    // The pure law, with the level-off assist switched off: reticle exactly on
    // the nose, nothing else touching it. Every axis must come out at zero.
    // With the assist ON the answer is deliberately *not* zero — it is the
    // small bounded nudge toward level described below — so the two have to be
    // measured separately or one hides the other.
    const levelOff = aim.cfg.levelOff;
    aim.cfg.levelOff = 0;
    aim.reset(view);
    aim.holdBoresight(view);
    settle();
    const boresight = { ...demand(), pitch: aim.out.pitch, yaw: aim.out.yaw };
    aim.cfg.levelOff = levelOff;

    // ...and with it back on. The assist may ask for something, but only ever
    // a little, and only ever toward level: an uncaptured aeroplane that could
    // command more than a nudge is one that can fly itself into the ground.
    aim.reset(view);
    aim.holdBoresight(view);
    settle();
    const speed = Math.max(1, view.vel.length());
    const parked = {
      theta: aim.theta * DEG,
      pitch: aim.out.pitch,
      bank: aim.bankDemand * DEG,
      gamma: Math.asin(Math.max(-1, Math.min(1, view.vel.y / speed))) * DEG,
    };

    // 10 px of mouse at the shipped sensitivity is 0.77° of pointing error.
    aim.reset(view); aim.steer(10, 0, right, up, 1); settle();
    const nudgeR = demand();
    aim.reset(view); aim.steer(-10, 0, right, up, 1); settle();
    const nudgeL = demand();
    // A decisive input: the reticle out at ~10° must ask for real bank.
    aim.reset(view); aim.steer(130, 0, right, up, 1); settle();
    const hard = demand();

    w.set(saved.x, saved.y, saved.z);
    aim.reset(view);
    aim.holdBoresight(view);
    return {
      boresight, parked, nudgeR, nudgeL, hard,
      bank: Math.atan2(view.right.y, view.up.y) * DEG,
      levelAssist: aim.cfg.levelAssist,
      pitchAttitude: Math.asin(Math.max(-1, Math.min(1, view.forward.y))) * DEG,
    };
  });
  const bs = director.boresight;
  // The wings coming level IS a command, and a correct one — so this asserts
  // the exact law rather than a budget: with no pointing error the roll demand
  // must be the standing bank times the leveller's gain, and nothing else.
  const wantsLevel = director.bank * director.levelAssist;
  check('reticle on the nose asks for no turn and no pull',
    Math.abs(bs.bank) < 0.05 && bs.theta < 1e-3
    && Math.abs(bs.pitch) < 0.02 && Math.abs(bs.yaw) < 0.15,
    `bank demand ${bs.bank.toFixed(3)}°, theta ${bs.theta.toExponential(1)}°,`
    + ` elevator ${bs.pitch.toFixed(4)}, rudder ${bs.yaw.toFixed(3)}`);
  // The level-off assist, bounded. It exists because "reticle on the nose" left
  // the elevator free, and a fighter at full throttle with a free elevator
  // pitches up into a stall — but an assist that could command more than a
  // nudge would be a worse bug than the one it fixes.
  const pk = director.parked;
  // Two bounds, both of them the law rather than an observation.
  //
  // The absolute ceiling is 'PARK_LEAD' in MouseAimController — 0.035 rad, 2.0°
  // — which is the hard clamp the assist is written around and therefore the
  // real guarantee. This used to assert 1.21°, which was not the law but the
  // reading taken off an aeroplane that happened to be within a fifth of a
  // degree of level when the sample was taken. With a full twenty-ship roster
  // the player is far more likely to be jostled during the preceding hands-off
  // window, the flight path sits a degree or so off, and a legal 1.56° nudge
  // correcting a 1.64° descent failed a test that was measuring the weather.
  //
  // The second bound is what the old number was reaching for and states it
  // properly: the offset may never exceed the flight-path error it exists to
  // correct. That is strictly tighter than 2° for a nearly level aeroplane, so
  // nothing is given away — an assist that manufactured a command out of a
  // level flight path still fails, which is the regression that matters.
  const PARK_LEAD_DEG = 0.035 * DEG;
  check('an uncaptured aeroplane is nudged toward level, and only nudged',
    pk.theta <= PARK_LEAD_DEG + 0.05
    && pk.theta <= Math.abs(pk.gamma) + 0.05
    && Math.abs(pk.bank) < 0.05
    && (Math.abs(pk.gamma) < 0.2 || Math.sign(pk.pitch) === -Math.sign(pk.gamma)),
    `reticle ${pk.theta.toFixed(2)}° off the nose (ceiling ${PARK_LEAD_DEG.toFixed(2)}°`
    + ` and never past the ${Math.abs(pk.gamma).toFixed(2)}° flight-path error),`
    + ` elevator ${pk.pitch.toFixed(3)} against a ${pk.gamma.toFixed(2)}° flight path`);
  check('with the reticle on the nose the only thing asked for is wings level',
    Math.abs(director.pitchAttitude) > 55 || Math.abs(bs.rollErr - wantsLevel) < 0.4,
    `roll demand ${bs.rollErr.toFixed(2)}° vs ${wantsLevel.toFixed(2)}° of leveller`
    + ` (${director.bank.toFixed(1)}° standing bank x ${director.levelAssist})`);
  // The regression itself. Before the fix, 0.77° of sideways pointing error
  // asked the aircraft to roll through 57° — 'atan2' of a sideways error is a
  // right angle however small the error — and that saturated the ailerons.
  check('a fraction of a degree of aim error asks for a fraction of a degree of roll',
    Math.abs(nudgeSpan(director) ) < 9,
    `${director.nudgeR.theta.toFixed(2)}° of error -> roll demand`
    + ` ${director.nudgeR.rollErr.toFixed(2)}° / ${director.nudgeL.rollErr.toFixed(2)}°`
    + ` (was ±57° before the fix)`);
  check('mouse right asks for right bank, mouse left for left',
    director.nudgeR.bank > 0.2 && director.nudgeL.bank < -0.2
    && director.hard.bank > director.nudgeR.bank,
    `nudge ${director.nudgeR.bank.toFixed(1)}° / ${director.nudgeL.bank.toFixed(1)}°,`
    + ` ${director.hard.theta.toFixed(1)}° of error -> ${director.hard.bank.toFixed(1)}° of bank`);
  check('a decisive input gets a decisive bank',
    director.hard.bank > 25 && Math.abs(director.hard.roll) > 0.2,
    `${director.hard.theta.toFixed(1)}° of error -> ${director.hard.bank.toFixed(1)}° bank,`
    + ` aileron ${director.hard.roll.toFixed(2)}`);
  await levelOff(2500);

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
  // Both paths field a full roster: the offline sandbox flies its own six-ship,
  // and the server backfills every empty slot with an AI flown by the same
  // 'AiPilot' (see server/Bots.ts). This used to print a note claiming the
  // server had no AI while counting seven of them.
  check('there is something to fight', opponents > 0,
    `${opponents} other aircraft ${mode === 'offline' ? 'in the sandbox' : 'on the server'}`);
  // The sky has to be *full*, not merely non-empty. A roster that quietly
  // halves itself — a bot backfill that stops topping up, an offline table
  // that was never raised to match the server — reads as "the game is dead"
  // long before anything fails, and 'opponents > 0' cannot see it.
  check('the roster fills the sky', opponents + 1 >= EXPECTED_ROSTER - ROSTER_SLACK,
    `${opponents + 1} of ${EXPECTED_ROSTER} aircraft airborne`);

  // --- 7b. identification ----------------------------------------------------
  //
  // The check this suite did not have.
  //
  // All 158 of the assertions before this one passed on a build where the HUD
  // painted contacts the wrong colour and named flak emplacements after
  // aeroplanes — because nothing anywhere compared a *rendered marker* against
  // the *entity it was drawn around*. Everything below reads the marker
  // elements the player is actually looking at and reconciles them with the
  // replicated state, which is the only way this class of bug is visible to a
  // test at all.
  console.log('\n7b. Identification');

  // Wait for something to actually be on the marker layer before reading it.
  // The contact list is range- and screen-bounded, so a single sample taken
  // while the nearest aeroplane happens to be behind the tail reads zero
  // markers — which would make the colour check pass vacuously if it were
  // tolerant and fail spuriously if it were not. With twenty aircraft up,
  // nothing being marked for eight seconds is itself worth failing on.
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(() => [...document.querySelectorAll('#ct-markers .ct-mk')]
      .filter((m) => m.style.display !== 'none').length);
    if (n > 0) break;
    await sleep(200);
  }

  const ident = await page.evaluate(() => {
    const g = window.__game;
    const me = g.entities.get(g.localEntityId);
    if (!me) return { fatal: 'the player has no aircraft in the entity table' };
    // Aircraft archetype -> the side that airframe belongs to. Mirrors
    // 'nationTeam' in src/shared/aircraft.ts; kept literal on purpose so a
    // change to that function cannot silently make this check agree with it.
    const NATION_TEAM = [0, 1, 0, 1, 0];
    const AC_NAMES = ['Spitfire', 'Bf 109', 'P-51', 'A6M', 'La-5'];

    const rows = [];
    for (const mk of document.querySelectorAll('#ct-markers .ct-mk')) {
      if (mk.style.display === 'none') continue;
      const e = g.entities.get(Number(mk.dataset.eid));
      if (!e) { rows.push({ why: 'marker bound to a nonexistent entity', ok: false }); continue; }
      const isGround = e.kind === 5;
      const lbl = mk.querySelector('.ct-mk-lbl');
      const showing = lbl && lbl.style.display !== 'none';
      const text = showing ? (mk.querySelector('.ct-mk-lbl span')?.textContent ?? '') : '';
      const colourOk = (e.team === me.team) === mk.classList.contains('is-ally')
        && (e.team !== me.team) === mk.classList.contains('is-enemy');
      const classOk = isGround === mk.classList.contains('is-ground');
      const nameOk = !(isGround && AC_NAMES.some((n) => text.includes(n)));
      rows.push({
        ok: colourOk && classOk && nameOk,
        colourOk, classOk, nameOk, isGround, text,
        team: e.team, myTeam: me.team,
      });
    }
    return {
      markers: rows.length,
      badColour: rows.filter((r) => !r.colourOk).length,
      badClass: rows.filter((r) => !r.classOk).length,
      badName: rows.filter((r) => !r.nameOk).length,
      groundNamed: rows.filter((r) => r.isGround && r.text).map((r) => r.text),
      myTeam: me.team,
      ctxLocalTeam: g.localTeam,
      assignedTeam: g.assignedTeam,
      myTypeId: e_typeId(me),
      myNationTeam: NATION_TEAM[me.typeId] ?? -1,
      // Every aircraft on the wire, not just the marked ones.
      incoherent: (() => {
        let n = 0;
        for (const e of g.entities.values()) {
          if (e.kind !== 1) continue;
          if ((NATION_TEAM[e.typeId] ?? e.team) !== e.team) n++;
        }
        return n;
      })(),
    };
    function e_typeId(e) { return e.typeId; }
  });

  if (ident.fatal) {
    check('the player has an aircraft to identify contacts from', false, ident.fatal);
  } else {
    check('every marker is coloured from the contact\'s own team',
      ident.markers > 0 && ident.badColour === 0,
      `${ident.markers} markers, ${ident.badColour} miscoloured`);
    check('ground contacts are drawn as ground, not as aircraft',
      ident.badClass === 0, `${ident.badClass} ground/air class mismatches`);
    check('no ground contact wears an aircraft name',
      ident.badName === 0,
      ident.groundNamed.length
        ? `ground labels seen: ${[...new Set(ident.groundNamed)].join(', ')}`
        : 'no ground labels visible this frame');
    // The drift the whole derivation exists to make impossible.
    check('the HUD\'s idea of "my team" is the team of my aircraft',
      ident.ctxLocalTeam === ident.myTeam,
      `ctx.localTeam ${ident.ctxLocalTeam}, my entity team ${ident.myTeam}, `
      + `roster said ${ident.assignedTeam}`);
    check('the player\'s airframe belongs to the side they fly for',
      ident.myNationTeam === ident.myTeam,
      `type ${ident.myTypeId} is a team-${ident.myNationTeam} airframe, `
      + `player is on team ${ident.myTeam}`);
    check('no aircraft in the match flies for the wrong side',
      ident.incoherent === 0, `${ident.incoherent} nation/team mismatches`);
  }

  // The hangar must not offer what the authority would refuse. This is the
  // other half of the same bug: a pilot picked a Mustang, the server
  // substituted a Messerschmitt without saying so, and every marker in the
  // game then disagreed with the aeroplane the player believed they were in.
  const hangarRoster = await page.evaluate(() => {
    const g = window.__game;
    const me = g.entities.get(g.localEntityId);
    const NATION_TEAM = { Spitfire: 0, 'Bf 109': 1, 'P-51': 0, A6M: 1, 'La-5': 0 };
    const names = [...document.querySelectorAll('#ct-hangar .ct-plane')]
      .map((p) => p.querySelector('.nm')?.textContent ?? '');
    const teams = names.map((n) => {
      const k = Object.keys(NATION_TEAM).find((x) => n.includes(x));
      return k === undefined ? -1 : NATION_TEAM[k];
    });
    return { names, teams, myTeam: me ? me.team : g.localTeam };
  });
  check('the hangar only offers aircraft this side can fly',
    hangarRoster.names.length > 0
      && hangarRoster.teams.every((t) => t === hangarRoster.myTeam),
    `team ${hangarRoster.myTeam} roster: ${hangarRoster.names.join(', ') || '(empty)'}`);

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

  // --- 9b. presentation ------------------------------------------------------
  //
  // Reported by the player as "the plane seems to be jittering in flight".
  // Neither of the two things that produce that is visible to any other check
  // here: they all either apply an input and measure the response, or sample a
  // scalar that is perfectly fine. Judder lives strictly between frames.
  //
  //   1. A stale transform. If the simulation ever advanced at a different rate
  //      from the presentation without interpolating between steps, the
  //      aeroplane would be drawn at the same attitude twice and then jump.
  //      Today the two are locked 1:1 by construction — the loop steps the model
  //      with the frame's own dt — and this is the guard that says so, so that
  //      anyone who later decouples them has to add the interpolation with it.
  //
  //   2. An alternating frame graph. Measured on a 120 Hz panel that could not
  //      quite hold it: the quality governor climbed to full rate, the frames
  //      came out 8.3, 16.7, 8.3, 16.7 — a "100 fps" average that reads as
  //      constant judder — and it stayed there for three seconds before backing
  //      off, on a timer, forever. The proportional miss rate below is the same
  //      signal the governor steers on, so this asserts that it converged.
  const pacing = await page.evaluate(async () => {
    const g = window.__game;
    const rows = [];
    for (let i = 0; i < 260; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const e = g.entities.get(g.localEntityId);
      if (!e) continue;
      rows.push({ frame: g.frame, dt: g.dt, qx: e.qx, qy: e.qy, qz: e.qz, qw: e.qw, px: e.px, py: e.py, pz: e.pz });
    }
    // One row per frame the game actually ran, in order.
    const steps = [];
    for (const r of rows) if (!steps.length || r.frame !== steps[steps.length - 1].frame) steps.push(r);
    let stale = 0;
    let miss = 0;
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i]; const b = steps[i - 1];
      if (a.qx === b.qx && a.qy === b.qy && a.qz === b.qz && a.qw === b.qw
        && a.px === b.px && a.py === b.py && a.pz === b.pz) stale++;
      // The governor's own signal: a step of more than 40 % between adjacent
      // intervals is a straddled vsync, not ordinary noise.
      if (Math.abs(a.dt - b.dt) > 0.4 * Math.min(a.dt, b.dt)) miss++;
    }
    const n = Math.max(1, steps.length - 1);
    return {
      frames: steps.length, stale: stale / n, miss: miss / n,
      presentEvery: g.presentEvery, refreshHz: g.refreshHz, quality: g.quality,
      medianDt: steps.map((r) => r.dt).sort((x, y) => x - y)[steps.length >> 1] * 1000,
    };
  });
  check('the aircraft transform advances on every frame the game draws',
    pacing.frames > 60 && pacing.stale < 0.02,
    `${(pacing.stale * 100).toFixed(1)}% of ${pacing.frames} drawn frames repeated the previous transform`);
  // The assertion is that the ladder *converged*, not that the hardware was
  // fast. A machine that cannot hold its refresh rate is expected to settle on
  // a lower rung with a locked cadence, and that passes with a miss rate near
  // zero; the failure this catches is the one that was measured — a governor
  // stuck at full rate with the frames alternating 8.3/16.7 ms, which lands at
  // 0.5 and above.
  check('frame pacing does not alternate between one and two refreshes',
    pacing.miss < 0.30,
    `${(pacing.miss * 100).toFixed(1)}% off-cadence at ${pacing.medianDt.toFixed(1)} ms`
    + ` (${pacing.quality}, present 1/${pacing.presentEvery} of ${pacing.refreshHz} Hz)`);

  if (mode === 'online') {
    const p = final?.pred;
    // Hard corrections mean the server and the client disagree by more than
    // 8 m — that is what rubber-banding looks like from the inside.
    const hardRate = p && p.corrections > 20 ? p.hard / p.corrections : 0;
    check('prediction is not fighting the server', !!p && hardRate < 0.05,
      p ? `${p.hard} hard of ${p.corrections} corrections, max ${p.maxErr.toFixed(1)} m` : '');
  }

  // --- 10. gunnery, online ---------------------------------------------------
  // The modular damage model. Offline the sandbox has always run it; online the
  // server used to set exactly one bit — 'Destroyed' — so an aeroplane went from
  // pristine to wreckage with nothing in between. This puts the player in the
  // saddle behind an AI and checks what comes back on the wire.
  if (mode === 'online') await onlineGunnery(page, tag, check);

  // --- 11. ground attack -----------------------------------------------------
  // Both paths now. The server sites its ground order of battle from the same
  // shared pass the renderer does and owns the stores, so a bombing run is
  // resolvable — and scored — online as well as in the sandbox.
  await groundAttack(page, tag, check, mode);

  // --- 12. controls, onboarding and the pointer ------------------------------
  await controlsAndOnboarding(page, tag, check);

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
/**
 * A gun pass on a live AI opponent, flown from the saddle.
 *
 * Everything about this is real except the run-in: the harness poses the
 * aircraft behind a bandit — through the server, which only accepts the request
 * because it was started with 'CT_DEBUG_PLACE' — and then holds the trigger with
 * a real mouse button. What is being asserted is that the rounds are arbitrated
 * by the server's modular damage model rather than by a single health scalar:
 * an aeroplane that has been hit must show *specific* damage on the wire, and
 * the wire has always been able to carry it.
 */
async function onlineGunnery(page, tag, check) {
  console.log('\n10. Online gunnery and modular damage');

  /** See the identically named helper in 'runSuite'. */
  const entityId = () => page.evaluate(() => window.__game.localEntityId);

  const target = await page.evaluate(() => {
    const g = window.__game;
    const me = g.entities.get(g.localEntityId);
    if (!me) return null;
    let best = null, bestD = Infinity;
    for (const e of g.entities.values()) {
      if (e.kind !== 1 || e.id === g.localEntityId || e.team === me.team) continue;
      if (e.health <= 0) continue;
      const d = Math.hypot(e.px - me.px, e.py - me.py, e.pz - me.pz);
      if (d < bestD) { bestD = d; best = e.id; }
    }
    return best === null ? null : { id: best, range: Math.round(bestD) };
  });
  check('an AI opponent is reachable on the server', !!target,
    target ? `entity ${target.id} at ${target.range} m` : 'no live opponents replicated');
  if (!target) return;

  /**
   * Slot in 150 m astern of the bandit, on its own velocity vector and pointing
   * straight at it.
   *
   * Not its *body* heading: an aeroplane at 8 degrees of alpha in a climbing
   * turn is not going where its nose is pointing, and slotting in behind the
   * nose leaves the target several degrees off the boresight — which at 200 m is
   * a ten-metre miss and, against a real collision proxy rather than a coarse
   * sphere, no hit at all.
   */
  const saddle = () => page.evaluate((id) => {
    const g = window.__game;
    const t = g.entities.get(id);
    if (!t || t.health <= 0) return false;
    const sp = Math.hypot(t.vx, t.vy, t.vz);
    if (sp < 1) return false;
    const dx = t.vx / sp, dy = t.vy / sp, dz = t.vz / sp;
    const R = 150;
    g.bus.emit('debug:place', {
      x: t.px - dx * R, y: t.py - dy * R, z: t.pz - dz * R,
      heading: Math.atan2(dx, dz),
      // Positive pitch is nose DOWN in this convention (see the bomb run
      // below), so pointing up the velocity vector is its negation.
      pitch: -Math.asin(Math.max(-1, Math.min(1, dy))),
      bank: 0, speed: sp + 15, opponent: null,
    });
    return true;
  }, target.id);

  const state = () => page.evaluate((id) => {
    const t = window.__game.entities.get(id);
    return t ? { damage: t.damage, health: t.health } : null;
  }, target.id);

  /** The bandit shoots back; a dead player can neither be placed nor fire. */
  const selfAlive = () => page.evaluate(() => {
    const g = window.__game;
    const e = g.entities.get(g.localEntityId);
    return !!e && e.health > 0 && !(e.damage & (1 << 13));
  });
  const rangeTo = () => page.evaluate((id) => {
    const g = window.__game;
    const me = g.entities.get(g.localEntityId);
    const t = g.entities.get(id);
    if (!me || !t) return null;
    const dx = t.px - me.px, dy = t.py - me.py, dz = t.pz - me.pz;
    const d = Math.hypot(dx, dy, dz) || 1;
    const fx = 2 * (me.qx * me.qz + me.qw * me.qy);
    const fy = 2 * (me.qy * me.qz - me.qw * me.qx);
    const fz = 1 - 2 * (me.qx * me.qx + me.qy * me.qy);
    const cos = (fx * dx + fy * dy + fz * dz) / d;
    return {
      d: Math.round(d),
      off: Math.round(Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI),
      bits: g.get('input')?.frame?.bits ?? -1,
    };
  }, target.id);

  await page.mouse.move(800, 450, { steps: 4 });
  const masks = new Set();
  let alive = true;
  let passes = 0;
  let skipped = 0;
  let closest = Infinity;
  let bestOff = 999;
  let lastBits = -1;
  let projectiles = 0;

  // Trigger held throughout, re-slotted every quarter of a second. The bandit is
  // flown by the same 'AiPilot' a human fights and it does not sit still: a
  // single long pass simply watches it fly out of the cone.
  //
  // "Held", however, is a fact about the *input subsystem*, not about the
  // mouse: a spawn resets the frame, so being shot down and replaced part-way
  // through leaves the trigger logically up with no further pointer event
  // coming to put it back. The loop watched forty passes go by with the guns
  // silent and reported that gunfire produces no damage — a false negative
  // that only appeared once the sky was full enough to shoot the harness down
  // mid-test. So the entity id is watched, and the trigger is re-pressed on
  // the aeroplane that replaced the one that was firing.
  let flying = await entityId();
  let rearmed = 0;
  let inputDiag = null;
  const holdTrigger = async () => {
    await page.mouse.down({ button: 'left' });
    await page.mouse.down({ button: 'right' });
  };
  const releaseTrigger = async () => {
    await page.mouse.up({ button: 'left' });
    await page.mouse.up({ button: 'right' });
  };
  await holdTrigger();
  /** Keep shooting until the damage is unambiguously modular, not just present. */
  const bitCount = () => [...masks].reduce((a, m) => a | m, 0).toString(2).split('1').length - 1;
  for (let pass = 0; pass < 40 && alive && bitCount() < 2; pass++) {
    if (!(await selfAlive())) { skipped++; await sleep(900); continue; }
    const now = await entityId();
    if (now !== flying) {
      flying = now;
      rearmed++;
      await releaseTrigger();
      await holdTrigger();
    }
    if (!(await saddle())) break;
    passes++;
    await sleep(130);
    for (let i = 0; i < 2; i++) {
      await sleep(90);
      const s = await state();
      if (!s) { alive = false; break; }
      if (s.damage) masks.add(s.damage);
      if (s.health <= 0) alive = false;
    }
    const r = await rangeTo();
    if (r) { closest = Math.min(closest, r.d); bestOff = Math.min(bestOff, r.off); lastBits = r.bits; }
    if (r && !(r.bits & 1) && !inputDiag) {
      inputDiag = await page.evaluate(() => {
        const g = window.__game;
        const inp = g.get('input');
        const ui = g.get('ui');
        return {
          suspended: inp?.suspended, screen: ui?.screen,
          modal: typeof ui?.isModal === 'function' ? ui.isModal() : '?',
          active: document.activeElement?.tagName,
          locked: !!document.pointerLockElement,
          mouseButtons: inp?.mouse?.buttons ?? inp?.mouse?.down ?? '?',
          deathOpen: ui?.death?.isOpen, scoreOpen: ui?.scoreOpen,
        };
      });
    }
    projectiles = Math.max(projectiles, await page.evaluate(COUNT_PROJECTILES));
  }
  await releaseTrigger();
  await page.screenshot({ path: `${tag}-08-gunnery.png` });

  const bits = [...masks].reduce((a, m) => a | m, 0);
  const nBits = bits.toString(2).split('1').length - 1;
  const DESTROYED = 1 << 13;
  check('gunfire produces damage on the wire', bits !== 0,
    `mask -> ${bits} after ${passes} pass(es) (${skipped} skipped while dead,`
    + ` ${rearmed} re-armed after a respawn),`
    + ` closest ${closest === Infinity ? '?' : closest} m, best off-nose ${bestOff}°,`
    + ` input bits 0x${(lastBits >>> 0).toString(16)}, ${projectiles} rounds in the air`
    + (inputDiag ? ` | first zero-trigger state: ${JSON.stringify(inputDiag)}` : ''));
  // The whole point: not a single 'Destroyed' bit. Wings, engines, fuel, the
  // pilot and the control runs are all separately replicated, and the client
  // already renders every one of them.
  check('online damage is modular, not a single destroyed flag',
    nBits >= 2 && (bits & ~DESTROYED) !== 0,
    `${nBits} distinct bits set (0x${bits.toString(16)})`);
}

/**
 * Everything a player needs in order to find out how to play, plus the two
 * pointer bugs that made the game unflyable.
 *
 * Every check here exists because the thing it tests was broken in a shipped
 * build, and three of them were invisible to every other test in this file —
 * the aeroplane flew perfectly in the harness precisely *because* the harness
 * drove it through the broken path.
 */
async function controlsAndOnboarding(page, tag, check) {
  console.log('\n12. Controls and onboarding');

  // -- the controls screen must not be able to lie ---------------------------
  //
  // There used to be two binding tables: the engine's, which dispatched the
  // game, and a private copy inside the settings panel, which was displayed.
  // They had drifted apart, so the controls screen confidently told players
  // that WEP was on R (Space), the camera on V (C) and the cannons on the
  // middle mouse button (the right one) — and rebinding on it changed nothing,
  // because nothing read what it wrote. This compares what is on screen with
  // what the input system will actually dispatch.
  await page.evaluate(() => {
    const ui = window.__game.get('ui');
    ui?.setScreen?.('flight');
    // Open the controls tab the way the pause menu does.
    ui?.openSettings?.('controls');
  });
  await sleep(600);
  const truth = await page.evaluate(() => {
    const bindings = window.__game.get('input')?.bindings;
    if (!bindings) return { ok: false, why: 'no binding table' };
    const rows = [...document.querySelectorAll('.ct-bind')];
    if (rows.length < 20) return { ok: false, why: `only ${rows.length} rows rendered` };
    // Spot-check the three that were wrong, by label text.
    const find = (rx) => rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()).find((t) => rx.test(t)) ?? '';
    const lbl = (a) => {
      const c = bindings.codesFor(a)[0] ?? '';
      if (c.startsWith('Mouse')) return ['LMB', 'MMB', 'RMB', 'M4', 'M5'][+c.slice(5)] ?? c;
      if (c.startsWith('Key')) return c.slice(3);
      return c;
    };
    const cases = [
      ['War emergency power', /emergency/i, 'wep'],
      ['Cycle camera', /cycle camera/i, 'cameraCycle'],
      ['Cannons', /cannons/i, 'fire2'],
      ['Landing gear', /landing gear/i, 'gear'],
    ];
    const bad = [];
    for (const [name, rx, action] of cases) {
      const shown = find(rx);
      const want = lbl(action);
      if (!shown || !shown.includes(want)) bad.push(`${name}: screen "${shown}" vs live "${want}"`);
    }
    return { ok: bad.length === 0, why: bad.join('; '), rows: rows.length };
  });
  check('the controls screen shows the bindings the game actually dispatches',
    !!truth && truth.ok, truth ? (truth.why || `${truth.rows} bindings listed`) : 'settings unavailable');

  await page.screenshot({ path: `${tag}-09-controls.png` });
  await page.evaluate(() => window.__game.get('ui')?.closeSettings?.());
  await sleep(400);

  // -- the in-flight legend --------------------------------------------------
  await page.keyboard.press('F1');
  await sleep(600);
  const legend = await page.evaluate(() => {
    const n = document.querySelector('.ct-legend');
    return {
      open: !!n && !n.classList.contains('ct-hidden'),
      rows: document.querySelectorAll('.ct-legend-row').length,
      // A legend that grabbed the pointer would eat the click that takes it.
      pe: n ? getComputedStyle(n).pointerEvents : 'x',
    };
  });
  check('F1 shows a control legend in flight', legend.open && legend.rows >= 20,
    `${legend.rows} bindings, pointer-events ${legend.pe}`);
  check('the legend does not capture the pointer', legend.pe === 'none');
  await page.keyboard.press('F1');
  await sleep(400);
  check('F1 closes the legend again',
    await page.evaluate(() => document.querySelector('.ct-legend')?.classList.contains('ct-hidden') === true));

  // -- pointer lock is requested by Deploy -----------------------------------
  //
  // The harness cannot hold pointer lock (Chromium refuses it unless the OS
  // window has focus, which it does not under automation), so this cannot
  // assert that the mouse *is* captured. It asserts the thing that is testable
  // and that actually regressed: that the game ASKED, from inside the Deploy
  // gesture. 'lockDenied' is only ever set by a refused request, so its being
  // true is proof that a request was made.
  const lock = await page.evaluate(() => {
    const m = window.__game.get('input')?.mouse;
    return m ? { denied: m.lockDenied, locked: m.locked, has: m.hasLocked } : null;
  });
  check('the game requests pointer lock without a second, undocumented click',
    !!lock && (lock.denied || lock.locked),
    lock ? `denied=${lock.denied} locked=${lock.locked}` : 'no mouse device');

  // -- an uncaptured pointer must not fly the aeroplane ----------------------
  //
  // THE bug the player reported as "the plane is jittery and moving around".
  // With the pointer uncaptured the reticle used to be pinned to the absolute
  // cursor position — so a cursor parked anywhere but dead centre held the
  // reticle at the edge of the aim cone and commanded a permanent max-rate
  // turn. Measured before the fix: cursor in the bottom-right corner gave
  // conePull 1.00 and a 126 m/s descent, indefinitely.
  //
  // The fallback is legitimate when pointer lock is genuinely unavailable, so
  // the flag is cleared for the duration of the check to exercise the path a
  // real browser takes, then restored.
  //
  // The cursor goes somewhere unhelpful first: parked dead centre it would pass
  // even with the bug fully present, because the reticle would be on the nose
  // for the wrong reason.
  await page.mouse.move(1480, 830, { steps: 8 });
  await sleep(300);
  const held = await page.evaluate(async () => {
    const input = window.__game.get('input');
    const m = input?.mouse;
    if (!m) return null;
    const was = m.lockDenied;
    m.lockDenied = false;                 // pretend lock is available but not held
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(2500);
    const theta = input.aim.theta;
    const cone = input.aim.out.conePull;
    const air0 = window.__game.get('flight').airData;
    let peakTheta = 0;
    for (let i = 0; i < 60; i++) {
      await wait(100);
      peakTheta = Math.max(peakTheta, input.aim.theta);
    }
    const air1 = window.__game.get('flight').airData;
    m.lockDenied = was;
    return {
      theta, cone, peakTheta,
      bank0: Math.abs(air0.rollAngle * 57.2958),
      bank1: Math.abs(air1.rollAngle * 57.2958),
      vs0: air0.vertSpeed, vs1: air1.vertSpeed,
      nx: m.nx, ny: m.ny, moved: m.movedUnlocked,
    };
  });
  // Put the cursor somewhere unhelpful first so the check has something to
  // catch: dead centre would pass even with the bug present.
  //
  // The reticle staying on the nose is the assertion. It is expressed as a hard
  // ceiling — 'PARK_LEAD' plus a whisker — because that is exactly the property
  // that makes an uncaptured pointer safe: the director may nudge the aeroplane
  // toward level, and it may do nothing else, no matter where the cursor is or
  // what the aeroplane is doing. The cursor sits at (0.85, −0.84); the bug this
  // catches put the reticle there, which is theta ≈ 0.5 rad and conePull 1.00.
  //
  // The attitude half used to be "pitch does not change much", and that has
  // stopped being the right corroboration: the reticle on the nose left the
  // elevator free and the aeroplane pitched slowly up into a stall, so an
  // uncaptured aeroplane now levels *off* rather than holding whatever it had.
  // Pitch therefore should change — toward level — and what must be asserted is
  // that the vertical speed is being taken out rather than put in. This check
  // runs at the end of a suite that has just flown a bombing run, so it starts
  // from whatever the pull-off left behind, which is the point.
  const settling = !!held
    && Math.abs(held.vs1) < Math.max(6, Math.abs(held.vs0) * 0.75);
  const holding = !!held && held.theta < 0.05 && held.peakTheta < 0.05
    && held.cone < 0.15 && settling && held.bank1 < Math.max(45, held.bank0 + 6);
  check('an uncaptured mouse levels the aeroplane off instead of flying at the cursor', holding,
    held
      ? `theta ${held.theta.toFixed(3)} rad (peak ${held.peakTheta.toFixed(3)}, ceiling 0.035),`
      + ` conePull ${held.cone.toFixed(2)}, bank ${held.bank0.toFixed(0)}° -> ${held.bank1.toFixed(0)}°,`
      + ` VS ${held.vs0.toFixed(0)} -> ${held.vs1.toFixed(0)} m/s`
      + ` (cursor at ${held.nx.toFixed(2)}, ${held.ny.toFixed(2)})`
      : 'no mouse device');
  // Leave the aeroplane pointing somewhere sensible for the final screenshot.
  await page.mouse.move(800, 450, { steps: 8 });
  await sleep(1500);

  // -- beginner assists ------------------------------------------------------
  //
  // Arcade is the default and must stay the default: the g limiter, the stall
  // guard, the auto-rudder and the wing leveller are what make "let go of the
  // controls" a valid recovery for someone who has never flown a simulator.
  const assists = await page.evaluate(() => {
    const cfg = window.__game.get('input')?.aim?.cfg;
    const prefs = window.__game.get('ui')?.prefs;
    return cfg ? {
      instructor: cfg.instructor, coordination: cfg.coordination,
      level: cfg.levelAssist, gLimit: cfg.gLimitFactor, stall: cfg.stallMargin,
      pref: prefs?.assists ?? '?',
    } : null;
  });
  check('beginner assists are on by default',
    !!assists && assists.instructor === true && assists.coordination > 0
    && assists.level > 0 && assists.gLimit <= 1 && assists.stall < 1 && assists.pref === 'arcade',
    assists
      ? `${assists.pref}: instructor=${assists.instructor}, rudder=${assists.coordination},`
      + ` level=${assists.level}, g×${assists.gLimit}, stall@${assists.stall}`
      : 'no aim controller');

  // -- flight school ---------------------------------------------------------
  //
  // It must exist, teach from the live bindings, be skippable, and — the part
  // that makes it acceptable rather than annoying — never block the game or
  // play twice.
  const school = await page.evaluate(() => {
    const ui = window.__game.get('ui');
    const n = document.querySelector('.ct-tut');
    if (!n || !ui) return null;
    return {
      exists: true,
      // By now the harness has flown the whole suite, so it is long finished.
      hiddenNow: n.classList.contains('ct-hidden'),
      seen: (() => { try { return localStorage.getItem('celthunder.tutorial.v1') === '1'; } catch { return false; } })(),
      pe: getComputedStyle(n).pointerEvents,
      skip: !!n.querySelector('.ct-tut-skip'),
      steps: n.querySelectorAll('.ct-tut-pip').length,
    };
  });
  check('flight school exists, with a Skip button and a step for each control',
    !!school && school.exists && school.skip && school.steps >= 5,
    school ? `${school.steps} steps` : 'not built');
  check('flight school never blocks the game or plays twice',
    !!school && school.pe === 'none' && school.hiddenNow && school.seen,
    school ? `pointer-events ${school.pe}, hidden ${school.hiddenNow}, seen ${school.seen}` : '');
}

async function groundAttack(page, tag, check, mode) {
  console.log('\n11. Ground attack');

  // --- rearm --------------------------------------------------------------
  await page.keyboard.press('Escape');
  await sleep(700);
  const toHangar = await clickButton(page, 'button.ct-navitem', 'change aircraft');
  const inHangar = toHangar && await waitForScreen(page, 'hangar', 6000);
  check('the hangar is reachable from the cockpit', inHangar,
    inHangar ? '' : `screen is "${await page.evaluate(SCREEN)}"`);
  if (!inHangar) return;

  // The Bf 109 carries a single SC 250 rather than a pair of 250 lb GPs, and an
  // online player may be on either side.
  const picked = await clickButton(page, '#ct-hangar button.ct-btn.is-ghost.is-sm', '250 lb')
    || await clickButton(page, '#ct-hangar button.ct-btn.is-ghost.is-sm', 'SC 250');
  check('a bomb loadout can be selected in the hangar', picked);
  await sleep(500);
  await page.screenshot({ path: `${tag}-08-loadout.png` });

  await clickButton(page, 'button.ct-btn.is-primary', 'deploy');
  const flying = await waitForScreen(page, 'flight', 8000);
  if (!flying) { check('deploying with stores puts the player back in the air', false); return; }
  await page.mouse.move(800, 450, { steps: 6 });
  await sleep(3500);

  const ORD = () => window.__game?.get?.('flight')?.ordnanceState ?? null;
  // Wait for the racks rather than sampling on a fixed delay. Online the
  // stores are the *server's* — they arrive in a 'stores' message some time
  // after the spawn — and a respawn in the middle of that (which a twenty-ship
  // match supplies readily) restarts the whole handshake. Reading once after
  // three and a half seconds caught the pre-stores state often enough to fail
  // the entire ground-attack section on a loadout that was in fact delivered:
  // the same run went on to release two bombs from an aeroplane the check had
  // just called clean.
  let armed = await page.evaluate(ORD);
  for (let i = 0; i < 40 && (!armed || armed.bombs < 1); i++) {
    await sleep(250);
    armed = await page.evaluate(ORD);
  }
  // Online this is the count the *server* sent back in 'stores': the racks are
  // its, and a client that simply believed its own hangar would be inventing
  // ordnance the match knows nothing about.
  check('the aircraft deploys carrying the chosen stores',
    !!armed && armed.loadout !== 'clean' && armed.bombs >= 1,
    armed ? `loadout "${armed.loadout}", ${armed.bombs} bombs (${mode})` : 'no ordnance state');
  check('stores are felt by the flight model as mass and drag',
    !!armed && armed.extraMass > 200 && armed.extraDrag > 0.05,
    armed ? `+${armed.extraMass.toFixed(0)} kg, +${armed.extraDrag.toFixed(3)} m² CdA` : '');

  const hudText = await page.evaluate(() => document.body.innerText || '');
  check('the HUD shows an ordnance readout',
    /STORES/i.test(hudText) && new RegExp(`${armed?.bombs ?? 2}/${armed?.bombs ?? 2}`).test(hudText),
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

  /*
   * The pass, flown up to twice.
   *
   * A dive-bombing run is six seconds of holding a line, and the assertion on
   * it is tight — the predicted impact has to come within 20 m. That is a fair
   * test of the bombsight and a hopeless one of the weather: with a full
   * twenty-ship roster the aeroplane can be hit, or shot down and replaced,
   * somewhere in those six seconds, and a hundred metres of miss then says
   * nothing whatever about the ordnance model. So the run watches for the
   * aeroplane being disturbed and re-flies once if it was — which the loadout
   * can afford, because it carries two bombs and only one pass is scored.
   */
  let aim = null;
  let best = 1e9;
  let sightSeen = false;
  let released = false;
  let passDisturbed = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.log(`  ..  bomb run discarded (${passDisturbed}) — re-flying`);
      passDisturbed = '';
      best = 1e9;
      released = false;
      await page.evaluate((tgt) => window.__game.bus.emit('debug:place', {
        x: tgt.x0, y: tgt.y0, z: tgt.z0, heading: tgt.heading,
        pitch: Math.atan2(330, 900), bank: 0, speed: 150, opponent: null,
      }), setup);
      await sleep(1200);
      armed = await page.evaluate(ORD);
      if (!armed || armed.bombs < 1) break;
    }
    const runId = await page.evaluate(() => window.__game.localEntityId);
    const runDmg = await page.evaluate(() => {
      const e = window.__game.entities.get(window.__game.localEntityId);
      return e ? e.damage : 0;
    });
    // One lateral correction, taken from the game's own impact solution: shift
    // the whole run-in sideways so the ground track passes over the target. This
    // is the harness standing in for the fifteen seconds of gentle S-turning a
    // pilot does on the way in, and it is the only part of the pass that is not
    // flown — the approach, the release and everything after it are real.
    aim = await page.evaluate((tgt) => {
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
    await sleep(500);

    // --- fly the pass and pickle ---------------------------------------------
    // The pipper sits a fixed distance ahead of the aeroplane and the target
    // walks back through it. Release on the crossing.
    let shotTaken = false;
    let prevAlong = Infinity;
    for (let i = 0; i < 160 && !released; i++) {
      const now = await page.evaluate(() => {
        const g = window.__game;
        const e = g.entities.get(g.localEntityId);
        return { id: g.localEntityId, damage: e ? e.damage : 0 };
      });
      if (now.id !== runId) passDisturbed = passDisturbed || 'shot down mid-run';
      else if (now.damage !== runDmg) passDisturbed = passDisturbed || 'hit mid-run';
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
      // 20 ms, not 40: the pipper crossing is detected on a poll, and at 150 m/s
      // every 20 ms of latency in noticing it is 3 m of along-track release
      // error. Online that error stacks on top of the input round trip.
      await sleep(20);
    }
    if (!passDisturbed || attempt > 0) break;
  }
  check('the bombsight produces a usable solution on the run-in', !!aim,
    aim ? `across-track correction ${aim.across.toFixed(0)} m` : 'no solution');
  check('the bombsight is flown onto the target', best < 20,
    `closest predicted impact ${best.toFixed(0)} m from the target`
    + (passDisturbed ? ` [DISTURBED: ${passDisturbed}]` : ''));
  check('the impact indicator is drawn on the way in', sightSeen,
    sightSeen ? 'pipper visible during the run' : 'pipper never shown');
  // Pull off the target rather than following the bomb into the ground.
  await page.mouse.move(800, 360, { steps: 4 });

  // One frame for the release to be consumed by the flight step.
  await sleep(300);
  // Online the release has to make a round trip: the bit goes up in the input
  // frame, the server drops the bomb, and the store comes back as a replicated
  // entity. Give it a few snapshots rather than a single frame.
  let after = await page.evaluate(ORD);
  for (let i = 0; i < 12 && (!after || after.bombs >= (armed?.bombs ?? 2)); i++) {
    await sleep(120);
    after = await page.evaluate(ORD);
  }
  check('pressing the release drops a store',
    !!after && !!armed && after.bombs === armed.bombs - 1 && after.inFlight >= 1,
    after ? `${after.bombs} left, ${after.inFlight} in flight` : '');
  check('releasing gives the performance back',
    !!after && !!armed && after.extraMass < armed.extraMass - 40
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

  // Online, the destruction has to be the *server's* verdict: the client's
  // ground targets are mirrors of replicated GroundUnit entities, and one that
  // has been destroyed stops being replicated at all.
  if (mode === 'online') {
    const gone = await page.evaluate((tgt) => {
      const g = window.__game;
      let units = 0;
      let nearest = null, bestD = Infinity;
      for (const e of g.entities.values()) {
        if (e.kind !== 5) continue;
        units++;
        const d = Math.hypot(e.px - tgt.x, e.pz - tgt.z);
        if (d < bestD) { bestD = d; nearest = e.health; }
      }
      const o = g.get('flight').ordnanceState;
      const t = o.targets.find((x) => x.id === tgt.id);
      return { units, alive: t ? t.alive : null, hp: t ? t.hp : null, nearest, bestD };
    }, setup);
    check('the server replicates its ground order of battle', gone.units > 20,
      `${gone.units} GroundUnit entities replicated`);
    // The point of the online run: the health the client is showing is the
    // server's, arrived over the wire as a GroundUnit entity, rather than a
    // number the client decremented for itself. Either the unit is gone from
    // the snapshot entirely (destroyed) or it is replicating below full health.
    check('the ground damage is the server\'s, not the client\'s',
      gone.alive === false || (gone.nearest !== null && gone.nearest < 0.999),
      gone.alive === false
        ? 'the unit stopped being replicated'
        : `nearest replicated unit at ${gone.bestD?.toFixed(0)} m reads health ${gone.nearest?.toFixed(2)}`);
  }
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
