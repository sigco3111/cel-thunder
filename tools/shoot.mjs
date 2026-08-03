/**
 * Screenshot harness for the visual-critique loop.
 *
 * Boots the dev server (if not already up), loads the game, waits for
 * `window.__ready`, then drives the debug camera into a set of named framings
 * and captures a PNG for each.
 *
 * Usage:
 *   node tools/shoot.mjs                       # all shots -> shots/
 *   node tools/shoot.mjs --shots dogfight,low  # subset
 *   node tools/shoot.mjs --out shots/round3    # custom output dir
 *   node tools/shoot.mjs --w 2560 --h 1440
 *   node tools/shoot.mjs --settle 2200         # ms to wait after each framing
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const OUT = arg('out', 'shots');
const W = parseInt(arg('w', '1920'), 10);
const H = parseInt(arg('h', '1080'), 10);
const URL_BASE = arg('url', 'http://localhost:5233');
/** A socket nothing listens on, so NetSystem falls back to the offline sandbox. */
const OFFLINE_SOCKET = 'ws://127.0.0.1:8799/ws';
const ONLY = arg('shots', '').split(',').filter(Boolean);
const WARMUP = parseInt(arg('warmup', '3500'), 10);
const SETTLE = parseInt(arg('settle', '1600'), 10);
/**
 * How long the fire control is held before the shutter, milliseconds.
 *
 * A burst is a balance between two things that both grow with its length. A
 * tracer leaves the muzzle at ~850 m/s, so it takes about 400 ms to draw the
 * 350 m streak that makes the shot read as gunnery rather than as a muzzle
 * flash. But the gun gas is emitted at the muzzle and left behind at 150 m/s,
 * so a burst held for the whole 1.6 s settle strings a 250 m rope of smoke puffs
 * across the frame and buries the subject in it. 420 ms fills the barrel-to-
 * target volume with tracer and leaves the smoke a short plume at the wing root,
 * which is what a gun camera frame actually looks like.
 */
const FIRE_MS = parseInt(arg('fire', '300'), 10);
/**
 * How long after the burst stops before the shutter opens, milliseconds.
 *
 * Firing *through* the exposure means the frame always contains a muzzle flash
 * at its brightest — a 300-pixel yellow star centred on the aircraft, which
 * buries the subject, blows the auto-exposure and drags the whole terrain three
 * stops down. Letting go a tenth of a second early costs nothing: the rounds
 * already fired are still in the air (a tracer covers ~85 m in that time and the
 * stream is 250 m long), while the flash and the freshest gun-gas puff have both
 * decayed. It is the difference between a photograph of a gun going off and a
 * photograph of an aeroplane shooting at something.
 */
const FIRE_TAIL = parseInt(arg('firetail', '110'), 10);

/**
 * Each shot names a camera framing the game exposes through
 * `window.__game.get('camera').debugFraming(name)`. Framings are chosen to
 * mirror how War Thunder screenshots are typically composed, so the blind
 * comparison is fair.
 */
const SHOTS = [
  'hero',          // 3/4 rear of the player aircraft, sun raking
  'dogfight',      // two aircraft mid-turn, horizon tilted
  'low',           // low pass over terrain, ground detail dominant
  'cockpit',       // pilot view with gunsight and instruments
  'clouds',        // climbing through cumulus, backlit
  'ground_attack', // strafing run on an airfield
  'sunset',        // golden-hour silhouette
  'water',         // over the coastline, stylised sea
  'damage',        // smoking, holed aircraft trailing fire
  'hud',           // gameplay frame with the full HUD on
];

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  return false;
}

let devProc = null;
async function ensureServer() {
  if (await waitForServer(URL_BASE, 1500)) return;
  console.log('[shoot] starting dev server…');
  devProc = spawn('npx', ['vite', '--port', '5233', '--strictPort'], {
    stdio: 'ignore', detached: false, env: process.env,
  });
  const ok = await waitForServer(URL_BASE, 60000);
  if (!ok) throw new Error('dev server failed to start');
}

/**
 * Detaches Vite's HMR client so the page cannot restart itself.
 *
 * Vite answers a `full-reload` message with `location.reload()`. Any file
 * touched anywhere in the project — a sibling agent saving, an editor
 * autosave, an indexer bumping mtimes — therefore reboots the game mid-run and
 * the harness captures a loading screen, or worse, calls `debugFraming` on a
 * half-initialised subsystem.
 *
 * Patching `location.reload` does not work: `Location` is
 * `[LegacyUnforgeable]`, so `defineProperty` on it throws. The reliable seam is
 * one level up — HMR only ever learns about a change through its WebSocket,
 * which it opens with the `vite-hmr` subprotocol. Hand that one connection a
 * socket that never opens and never closes and the client sits silently
 * waiting forever, while the game's own WebSocket to the match server is
 * untouched. Harness-only; a real player still gets HMR.
 */
const PIN_PAGE = () => {
  // Pointer lock cannot succeed in this browser and must not be attempted.
  //
  // The framings that ask for tracers need a real Mouse0 press, and the input
  // layer answers any press by requesting pointer lock. Playwright's page is not
  // hosted in a document Chromium considers a valid lock root, so every request
  // raises 'WrongDocumentError' — asynchronously, past the input layer's own
  // try/catch — and lands in the harness's console-error tally, which the
  // capture run is required to keep at zero. The harness never needs the lock:
  // it sends absolute pointer coordinates, not deltas. Replacing the request
  // with a no-op leaves the game's unlocked aiming path — the one that reads the
  // cursor's position on the canvas — doing exactly what it does for a player
  // who has not clicked in yet.
  const noLock = function requestPointerLock() { return Promise.resolve(); };
  try { Element.prototype.requestPointerLock = noLock; } catch { /* frozen */ }

  const NativeWebSocket = window.WebSocket;
  const isHmr = (protocols) => protocols === 'vite-hmr'
    || (Array.isArray(protocols) && protocols.includes('vite-hmr'));

  // A socket stuck in CONNECTING: no 'open', no 'close', so Vite neither
  // applies updates nor starts its reconnect loop.
  const deadSocket = () => ({
    readyState: 0, url: '', protocol: '', extensions: '', bufferedAmount: 0,
    binaryType: 'blob',
    onopen: null, onclose: null, onerror: null, onmessage: null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    send() {}, close() {},
  });

  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      if (isHmr(args[1])) return deadSocket();
      return Reflect.construct(target, args);
    },
  });
};

/**
 * Waits for the frame rate to stop being a measurement of shader compilation.
 *
 * A cold page compiles a few hundred programs lazily, as each material is first
 * drawn, and the renderer's adaptive quality reacts to the resulting stalls by
 * dropping a tier. Capture during that window and the run reports 35 fps at
 * 'medium' for a scene that settles at 120 at 'ultra' twenty seconds later — a
 * false regression that costs more time to chase than it does to prevent, and
 * one that also changes the *look* of the frame, because a dropped tier turns
 * passes off. Polling for a stable frame rate instead of sleeping a fixed
 * interval makes the run self-timing: fast on a warm cache, patient on a cold
 * one.
 */
async function settleFrameRate(page, budgetMs, floor = 58) {
  const deadline = Date.now() + budgetMs;
  let good = 0;
  while (Date.now() < deadline) {
    const fps = await page.evaluate(() => window.__game?.stats?.fps ?? 0).catch(() => 0);
    if (fps >= floor) { if (++good >= 3) return fps; } else good = 0;
    await sleep(500);
  }
  return null;
}

function fmt(n, digits = 0) {
  if (!Number.isFinite(n)) return '?';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/**
 * Removes the "server unavailable — flying offline" banner from the HUD.
 *
 * The harness deliberately does *not* start `server/`: online, the server owns
 * every actor, so `debug:place` becomes a no-op and none of the ten framings can
 * pose their subject at all. Offline is the only mode in which the shots exist.
 * The banner is therefore an artifact of the capture rig rather than a state a
 * player would ever be screenshotted in, and the rubric scores an error banner
 * in frame as an automatic UI failure.
 *
 * Matched on text rather than by hiding `#ct-notices` wholesale, so a real
 * gameplay notice (a warning, an objective) still lands in the picture.
 */
const STRIP_CONNECTION_CHROME = () => {
  const box = document.getElementById('ct-notices');
  if (!box) return;
  for (const n of Array.from(box.children)) {
    if (/flying offline/i.test(n.textContent ?? '')) n.remove();
  }
};

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  await ensureServer();

  const browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
    ],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.addInitScript(PIN_PAGE);

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));

  // Force the offline sandbox by pointing the client at a dead socket.
  //
  // This is not a convenience — it is a correctness requirement. The framings
  // pose their subject by emitting `debug:place`, which FlightSystem no-ops
  // whenever a server is answering, because online the server owns every actor
  // and a client-side teleport would be a desync. So if ANY game server happens
  // to be listening on :8791 — and `playtest.mjs` leaves one running — every
  // capture silently comes out with no aircraft in it, while the harness still
  // prints "0 errors" and 120 fps. A whole round of screenshots was reviewed
  // and scored before anyone noticed the frames were empty.
  const captureUrl = URL_BASE.includes('?')
    ? `${URL_BASE}&server=${OFFLINE_SOCKET}`
    : `${URL_BASE}/?server=${OFFLINE_SOCKET}`;
  console.log(`[shoot] loading ${captureUrl}`);
  await page.goto(captureUrl, { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForFunction('window.__ready === true', { timeout: 90000 });
  } catch {
    console.error('[shoot] game never signalled ready. Console errors:');
    errors.slice(0, 20).forEach((e) => console.error('  ', e));
    const boot = await page.evaluate(
      () => document.getElementById('boot-msg')?.textContent ?? '(no boot overlay)',
    ).catch(() => '(page unreachable)');
    console.error(`[shoot] boot overlay stuck at: "${boot}"`);
    await page.screenshot({ path: `${OUT}/_FAILED_boot.png` });
    await browser.close();
    if (devProc) devProc.kill();
    process.exit(1);
  }

  // Report anything the engine skipped rather than letting it hide in the log.
  const skipped = await page.evaluate(() => window.__game?.failedSubsystems ?? []);
  if (skipped.length) {
    console.log(`[shoot] ${skipped.length} subsystem(s) SKIPPED at boot:`);
    for (const s of skipped) console.log(`  ! ${s.name}: ${s.error}`);
  }

  // Let terrain stream in, clouds settle, particle systems reach steady state.
  await sleep(WARMUP);
  const steady = await settleFrameRate(page, 45000);
  if (steady === null) {
    console.log('[shoot] ! frame rate never settled — the numbers below include compile stalls');
  }

  // Park the pointer on the boresight once, before anything is captured.
  //
  // The fire control is bound to Mouse0, so the framings that ask for tracers
  // need a real button press — and a press lands wherever the pointer happens
  // to be, which for a fresh Playwright page is (0,0): the corner of the HUD,
  // not the canvas. Centring it also puts the reticle exactly on boresight, so
  // the mouse-aim controller sees zero pointing error and holds the posed
  // attitude instead of hauling the aeroplane round mid-shot. Done once: after
  // the first click the page may hold pointer lock, and further moves would be
  // read as look input.
  await page.mouse.move(Math.floor(W / 2), Math.floor(H / 2));

  const rows = [];
  const list = ONLY.length ? ONLY : SHOTS;
  for (const shot of list) {
    const before = errors.length;

    // The engine can still be booting (a reload we did not manage to prevent,
    // or a slow first frame). Driving a framing into a subsystem whose `init`
    // has not run yet produces a confusing "cannot read properties of
    // undefined" instead of a screenshot, so wait for a live frame loop first.
    await page.waitForFunction(
      () => window.__ready === true && window.__game?.frame > 0
        && typeof window.__game.get('camera')?.debugFraming === 'function',
      { timeout: 30000 },
    ).catch(() => errors.push(`engine not running before "${shot}"`));

    const apply = () => page.evaluate((name) => {
      const g = window.__game;
      const cam = g?.get?.('camera');
      if (cam && typeof cam.debugFraming === 'function') { cam.debugFraming(name); return true; }
      return false;
    }, shot).catch((e) => { errors.push(`debugFraming("${shot}") threw: ${e.message}`); return false; });

    let applied = await apply();

    // Applied twice, and the second one is not belt-and-braces.
    //
    // A framing change is also a shader event: a new time of day, a new weather
    // directive, and for the combat frames the first tracer, muzzle-flash and
    // impact materials of the whole run all compile the first time they are
    // drawn. Waiting for that to clear is necessary — but everything in the
    // shot is *moving* while we wait. The opponent closes head-on at 275 m/s,
    // so eight seconds of compile stall is two kilometres of closure, and the
    // second aeroplane the framing exists to show has already merged, passed and
    // gone: the dogfight frame came back with tracers and no bandit.
    //
    // So the warm-up and the timed window are separated. The first apply pays
    // the compile cost; re-applying re-poses the subject and the opponent from
    // scratch and re-seats every camera spring, so the interval that actually
    // decides the composition is exactly SETTLE, on warm shaders, every time.
    if (applied) {
      const warmed = await settleFrameRate(page, 8000);
      if (warmed !== null) applied = await apply();
    }

    // Framings that are about combat ask for gunfire, and the fire control is a
    // real mouse button — so the harness presses it. See FIRE_MS for why the
    // burst is short and why it comes at the end of the settle rather than the
    // start.
    const scene = await page.evaluate(
      () => window.__game?.get('camera')?.framingScene ?? null,
    ).catch(() => null);
    const shooting = applied && !!scene?.firing;

    // Framings change lighting/time-of-day, so give the sky and streaming a
    // moment to catch up before capturing.
    const burst = shooting ? FIRE_MS + FIRE_TAIL : 0;
    await sleep(applied ? Math.max(200, SETTLE - burst) : 300);
    if (shooting) {
      await page.mouse.down();
      await sleep(FIRE_MS);
      await page.mouse.up();
      await sleep(FIRE_TAIL);
    }

    // Stats are sampled after the settle so the numbers describe the frame we
    // are about to capture, not the one before the camera moved.
    const stats = await page.evaluate(() => {
      const g = window.__game;
      const s = g?.stats;
      return s
        ? { fps: s.fps, quality: s.quality, drawCalls: s.drawCalls, triangles: s.triangles, frame: g.frame }
        : null;
    }).catch(() => null);

    await page.evaluate(STRIP_CONNECTION_CHROME).catch(() => {});

    // Assert the frame actually contains what the framing promised, BEFORE it
    // is written. A capture with no aircraft in it is not a screenshot of the
    // game, and one round of ten such frames was reviewed and scored in full
    // before anyone noticed. Silence is not success: say so on the shot.
    const content = await page.evaluate(() => {
      const g = window.__game;
      if (!g) return { aircraft: 0, local: 0, entities: 0 };
      let aircraft = 0;
      for (const e of g.entities.values()) if (e.kind === 1) aircraft++;
      return {
        aircraft,
        local: g.localEntityId,
        entities: g.entities.size,
        hasLocal: g.entities.has(g.localEntityId),
      };
    }).catch(() => null);

    const empty = !content || content.aircraft === 0 || !content.hasLocal;
    if (empty) {
      errors.push(
        `"${shot}" captured with no subject `
        + `(aircraft=${content?.aircraft ?? '?'}, localEntityId=${content?.local ?? '?'}, `
        + `entities=${content?.entities ?? '?'}) — is a game server answering on :8791? `
        + 'debug:place is a no-op online.',
      );
    }

    const path = `${OUT}/${shot}.png`;
    await page.screenshot({ path });

    const shotErrors = errors.slice(before);
    rows.push({ shot, applied, stats, errors: shotErrors.length, empty });
    const perf = stats
      ? `${fmt(stats.fps, 1)} fps · ${stats.quality} · ${fmt(stats.drawCalls)} calls · ${fmt(stats.triangles)} tris`
      : 'no stats';
    console.log(`[shoot] ${applied ? '✓' : '· (no framing hook)'} ${path}  [${perf}]`);
    if (shotErrors.length) {
      shotErrors.slice(0, 4).forEach((e) => console.log(`         ! ${e.slice(0, 240)}`));
    }
  }

  // --- summary -------------------------------------------------------------
  console.log('\n[shoot] framing        fps   quality  draw calls  triangles  errors  subject');
  for (const r of rows) {
    const s = r.stats;
    console.log(
      `        ${r.shot.padEnd(14)}${(s ? fmt(s.fps, 1) : '?').padStart(5)}  ${(s?.quality ?? '?').padEnd(8)}`
      + `${(s ? fmt(s.drawCalls) : '?').padStart(10)}  ${(s ? fmt(s.triangles) : '?').padStart(9)}`
      + `${String(r.errors).padStart(8)}  ${r.empty ? 'MISSING' : 'ok'}`,
    );
  }

  const emptyShots = rows.filter((r) => r.empty);
  if (emptyShots.length) {
    console.log(
      `\n[shoot] \x1b[31m${emptyShots.length}/${rows.length} CAPTURES HAVE NO AIRCRAFT IN THEM\x1b[0m`
      + ` — ${emptyShots.map((r) => r.shot).join(', ')}`,
    );
    console.log('        These frames are worthless. Do not review or score them.');
    console.log('        Most likely a game server is answering on :8791; debug:place no-ops online.');
  }

  if (errors.length) {
    console.log(`\n[shoot] ${errors.length} console error(s):`);
    const seen = new Set();
    for (const e of errors) {
      const key = e.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      console.log('  !', e.slice(0, 400));
      if (seen.size >= 15) break;
    }
  }

  await browser.close();
  if (devProc) devProc.kill();
}

main().catch((e) => { console.error(e); if (devProc) devProc.kill(); process.exit(1); });
