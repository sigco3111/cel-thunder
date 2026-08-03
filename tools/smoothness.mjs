/**
 * Smoothness and responsiveness harness.
 *
 * "120 fps" is an average, and an average hides exactly the thing that makes a
 * game feel bad. A frame graph that averages 120 but drops a 40 ms frame every
 * second feels worse than a rock-steady 60. So this measures what a player
 * actually perceives:
 *
 *   - **1% and 0.1% low frame times** — the worst frames, which are what a
 *     player registers as a stutter.
 *   - **Frame-time consistency** (mean absolute successive difference). A
 *     perfectly paced 60 fps has ~0 ms of jitter; anything above ~2 ms reads
 *     as micro-stutter even when the average is high.
 *   - **Hitches**: frames over 33 ms (a dropped frame at 30 fps) and over
 *     50 ms (a visible lurch).
 *   - **Input-to-response latency**: how many milliseconds pass between a key
 *     going down and the aircraft's angular rate actually changing. This is
 *     the number that decides whether controls feel "tight" or "floaty".
 *   - **Sustained-load behaviour**: the same numbers while a fight is
 *     happening, because a build that is smooth on an empty sky and hitches
 *     when the guns fire is not smooth.
 *
 * Usage: node tools/smoothness.mjs [--headed] [--seconds 20]
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const SECONDS = Number(argv[argv.indexOf('--seconds') + 1]) || 15;
const PORT = 5235;
const WEB = `http://localhost:${PORT}`;
const OFFLINE = `${WEB}/?server=ws://127.0.0.1:8799/ws`;
const OUT = 'shots/smoothness';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}  ${detail}`);
};

async function reachable(url, ms) {
  const t0 = Date.now();
  do { try { if ((await fetch(url)).ok) return true; } catch {} await sleep(400); }
  while (Date.now() - t0 < ms);
  return false;
}

/** Installs a rAF probe that records raw frame deltas in the page. */
const INSTALL_PROBE = () => {
  const w = window;
  w.__frames = [];
  w.__probing = false;
  const tick = (t) => {
    if (w.__probing && w.__lastT !== undefined) w.__frames.push(t - w.__lastT);
    w.__lastT = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const STATS = () => {
  const f = window.__frames.slice().sort((a, b) => a - b);
  if (f.length < 30) return null;
  const n = f.length;
  const sum = f.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const pct = (p) => f[Math.min(n - 1, Math.floor(n * p))];
  // Mean absolute successive difference on the ORIGINAL order, not sorted.
  const raw = window.__frames;
  let jit = 0;
  for (let i = 1; i < raw.length; i++) jit += Math.abs(raw[i] - raw[i - 1]);
  jit /= Math.max(1, raw.length - 1);
  return {
    frames: n,
    meanMs: +mean.toFixed(2),
    fps: +(1000 / mean).toFixed(1),
    medianMs: +pct(0.5).toFixed(2),
    p99Ms: +pct(0.99).toFixed(2),
    p999Ms: +pct(0.999).toFixed(2),
    worstMs: +f[n - 1].toFixed(2),
    jitterMs: +jit.toFixed(2),
    hitches33: raw.filter((x) => x > 33).length,
    hitches50: raw.filter((x) => x > 50).length,
  };
};

let devProc = null;

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  if (!(await reachable(WEB, 800))) {
    devProc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
      { stdio: 'ignore', env: { ...process.env, CT_NO_HMR: '1' } });
    if (!(await reachable(WEB, 90000))) throw new Error('web server failed to start');
  }

  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(INSTALL_PROBE);

  console.log('\n\x1b[1mCEL THUNDER — smoothness and responsiveness\x1b[0m\n');
  await page.goto(OFFLINE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__ready === true', { timeout: 90000 });
  await sleep(2500);

  // Get into the cockpit through the real UI.
  const click = async (label) => {
    const box = await page.evaluate((want) => {
      const rx = new RegExp(want, 'i');
      const n = [...document.querySelectorAll('button,[role=button],.ct-btn,.ct-menu-item')]
        .find((b) => rx.test((b.textContent || '').trim()) && b.getBoundingClientRect().width > 2);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, label);
    if (box) { await page.mouse.click(box.x, box.y); return true; }
    return false;
  };
  await click('^play$'); await sleep(1200);
  await page.keyboard.press('Enter'); await sleep(1200);
  await click('deploy|take off'); await sleep(3500);

  const spawned = await page.evaluate(() => window.__game?.localEntityId ?? 0);
  if (!spawned) { console.error('  could not deploy — aborting'); await browser.close(); devProc?.kill(); process.exit(1); }

  // ---- 1. steady cruise ----------------------------------------------------
  console.log(`1. Steady flight (${SECONDS}s)`);
  await page.evaluate(() => { window.__frames.length = 0; window.__probing = true; });
  await sleep(SECONDS * 1000);
  await page.evaluate(() => { window.__probing = false; });
  const cruise = await page.evaluate(STATS);
  report('cruise', cruise);

  // ---- 2. under combat load ------------------------------------------------
  console.log('\n2. Under combat load (firing + manoeuvring)');
  await page.mouse.click(960, 540);
  await page.evaluate(() => { window.__frames.length = 0; window.__probing = true; });
  await page.keyboard.down('KeyD');
  await page.mouse.down({ button: 'left' });
  await sleep(Math.round(SECONDS * 0.5) * 1000);
  await page.keyboard.up('KeyD');
  await page.keyboard.down('KeyS');
  await sleep(Math.round(SECONDS * 0.5) * 1000);
  await page.mouse.up({ button: 'left' });
  await page.keyboard.up('KeyS');
  await page.evaluate(() => { window.__probing = false; });
  const combat = await page.evaluate(STATS);
  report('combat', combat);

  // ---- 3. input latency ----------------------------------------------------
  //
  // Two things about this measurement, both learned the hard way.
  //
  // 1. The arm/press ordering has to be exactly this. Awaiting the page-side
  //    promise *before* dispatching the key means the promise has already
  //    settled by the time the key is pressed, so what gets timed is however
  //    long the aeroplane took to drift 2.3 degrees on its own — ambient
  //    motion, not input response. That reads as a plausible-looking 20-90 ms
  //    with occasional 500 ms timeouts, and it does not move when the control
  //    chain is made three times faster, because it was never measuring it.
  //
  // 2. An aeroplane in flight is *always* rotating, so "the attitude changed"
  //    is not evidence of anything by itself. What matters is that the attitude
  //    changed **away from the trajectory it was already on**. So the pre-input
  //    body rate is measured first and extrapolated forward, and the clock
  //    stops when the real attitude departs from that prediction. That is the
  //    moment the player's input became visible on screen, and it is stable
  //    whether the aircraft was straight and level or mid-turn.
  //
  // The clock starts inside the page, on the real 'keydown' event, so the
  // number excludes the harness's own CDP round trip and includes everything
  // the player actually waits for: event dispatch, input sampling, the flight
  // director, the physics step and the publish into the entity table.
  console.log('\n3. Input responsiveness');
  // Measure from a settled aeroplane. Running straight out of the combat phase
  // sampled a machine that was mid-departure, damaged or dead, which put ~10 ms
  // of run-to-run spread on the result for reasons that have nothing to do with
  // the control chain.
  await sleep(2500);
  await page.evaluate(() => {
    const w = window;
    // Quaternion helpers, body-frame: d = conj(a) * b.
    const rel = (a, b) => {
      const [ax, ay, az, aw] = a;
      const [bx, by, bz, bw] = b;
      return [
        aw * bx - ax * bw - ay * bz + az * by,
        aw * by + ax * bz - ay * bw - az * bx,
        aw * bz - ax * by + ay * bx - az * bw,
        aw * bw + ax * bx + ay * by + az * bz,
      ];
    };
    const angleOf = (q) => 2 * Math.acos(Math.min(1, Math.abs(q[3])));
    const DEV_RAD = 0.15 * Math.PI / 180;
    w.__latArm = () => {
      const g = w.__game;
      const st = { hist: [], base: null, baseT: 0, axis: [0, 0, 0], rate: 0, keyT: 0, result: null, rows: [] };
      w.__lat = st;
      const grab = () => {
        const e = g.entities.get(g.localEntityId);
        return e ? [e.qx, e.qy, e.qz, e.qw] : null;
      };
      const onKey = () => { if (!st.keyT) st.keyT = performance.now(); };
      addEventListener('keydown', onKey, true);
      const step = () => {
        const now = performance.now();
        const q = grab();
        if (!q) { requestAnimationFrame(step); return; }

        if (!st.keyT) {
          // Pre-input: estimate the current turn rate over a short history
          // rather than from one frame. A single-frame difference is dominated
          // by integrator noise, and the extrapolation it produces is wrong in
          // both directions — sometimes tripping the threshold before the input
          // could possibly have arrived, sometimes masking a real response.
          st.hist.push({ q, t: now });
          if (st.hist.length > 8) st.hist.shift();
          if (st.hist.length >= 4) {
            const a = st.hist[0];
            const dt = Math.max(1e-3, (now - a.t) / 1000);
            const d = rel(a.q, q);
            const ang = angleOf(d);
            const s = Math.hypot(d[0], d[1], d[2]);
            if (s > 1e-9) {
              st.axis = [d[0] / s, d[1] / s, d[2] / s];
              st.rate = (d[3] < 0 ? -ang : ang) / dt;
            }
            st.base = q; st.baseT = now;
          }
          requestAnimationFrame(step); return;
        }

        // Post-input: compare against "it kept turning exactly as it was".
        const t = (now - st.baseT) / 1000;
        const half = (st.rate * t) / 2;
        const s = Math.sin(half);
        const pred = [st.axis[0] * s, st.axis[1] * s, st.axis[2] * s, Math.cos(half)];
        // predicted world quaternion = base * pred
        const [px, py, pz, pw] = pred;
        const [bx, by, bz, bw] = st.base;
        const P = [
          bw * px + bx * pw + by * pz - bz * py,
          bw * py - bx * pz + by * pw + bz * px,
          bw * pz + bx * py - by * px + bz * pw,
          bw * pw - bx * px - by * py - bz * pz,
        ];
        const dev = angleOf(rel(P, q));
        st.rows.push({ t: now - st.keyT, dev });
        // Threshold = the smallest nose movement a player can actually see.
        // At 1080p and a 68 degree vertical FOV one pixel is 0.063 degrees, so
        // two or three pixels of movement — 0.15 degrees, DEV_RAD below — is
        // the onset of visible response.
        //
        // The original 2.3 degrees was not a latency threshold at all, it was a
        // developed bank angle: reaching it needs the roll rate to build
        // against the airframe's roll inertia, which takes ~90 ms on a Spitfire
        // no matter how quickly the stick moves. Measuring that and calling it
        // input lag makes the control chain look broken when it is not, and it
        // cannot be driven under 30 ms by any amount of software work. The
        // tight threshold is only usable because the baseline above
        // extrapolates the aircraft's prior rotation instead of comparing
        // against a frozen quaternion; against a frozen one, 0.15 degrees would
        // be pure ambient noise.
        if (dev > DEV_RAD) {
          st.result = now - st.keyT;
          removeEventListener('keydown', onKey, true);
          return;
        }
        if (now - st.keyT > 600) {
          st.result = -1;
          removeEventListener('keydown', onKey, true);
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
  });

  const lat = [];
  const curves = [];
  // Ten samples, not six: the median of six carried about +-3 ms of noise,
  // which is the same size as the effect being measured.
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.__latArm());
    await sleep(150);                       // let the pre-input rate estimate settle
    await page.keyboard.down('KeyA');       // armed first, pressed second
    await page.waitForFunction('window.__lat.result !== null', { timeout: 5000 }).catch(() => {});
    const r = await page.evaluate(() => ({ ms: window.__lat.result, rows: window.__lat.rows }));
    await page.keyboard.up('KeyA');
    await sleep(700);
    if (r.ms > 0) { lat.push(r.ms); curves.push(r.rows); }
  }
  lat.sort((a, b) => a - b);
  const medLat = lat.length ? lat[lat.length >> 1] : -1;
  console.log(`  key-down -> nose visibly moves (0.15 deg): ${lat.map((x) => x.toFixed(0)).join(', ')} ms`);

  // The rest of the response curve, printed so the aerodynamic part of the
  // delay is visible rather than hidden inside one number.
  const at = (deg) => {
    const ts = curves
      .map((rows) => rows.find((x) => x.dev * 180 / Math.PI > deg))
      .filter(Boolean).map((x) => x.t).sort((a, b) => a - b);
    return ts.length ? `${ts[ts.length >> 1].toFixed(0)} ms` : '--';
  };
  console.log(`  response curve: 0.15deg ${at(0.15)} · 0.5deg ${at(0.5)} · 1deg ${at(1)} · 2.3deg ${at(2.3)}`
    + '   (beyond ~0.2 deg this is roll inertia, not latency)');
  check('input latency under 30 ms', medLat > 0 && medLat < 30, `median ${medLat.toFixed(1)} ms of ${lat.length} samples`);

  await page.screenshot({ path: `${OUT}/final.png` });

  // ---- verdict -------------------------------------------------------------
  console.log('\n\x1b[1mVerdict\x1b[0m');
  for (const [label, s] of [['cruise', cruise], ['combat', combat]]) {
    if (!s) continue;
    check(`${label}: no visible hitches (>50 ms)`, s.hitches50 === 0, `${s.hitches50} hitches`);
    check(`${label}: dropped frames (>33 ms) under 1%`, s.hitches33 / s.frames < 0.01,
      `${s.hitches33}/${s.frames} = ${(100 * s.hitches33 / s.frames).toFixed(2)}%`);
    check(`${label}: frame pacing steady (jitter < 4 ms)`, s.jitterMs < 4, `${s.jitterMs} ms`);
    check(`${label}: 1% low above 30 fps`, s.p99Ms < 33.3, `p99 ${s.p99Ms} ms = ${(1000 / s.p99Ms).toFixed(0)} fps`);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n\x1b[1m${passed}/${results.length} checks passed\x1b[0m\n`);
  await browser.close();
  devProc?.kill();
  process.exit(passed === results.length ? 0 : 1);
}

function report(label, s) {
  if (!s) { console.log(`  ${label}: insufficient samples`); return; }
  console.log(`  ${s.frames} frames · avg ${s.fps} fps (${s.meanMs} ms) · median ${s.medianMs} ms`);
  console.log(`  1% low ${s.p99Ms} ms (${(1000 / s.p99Ms).toFixed(0)} fps) · 0.1% low ${s.p999Ms} ms · worst ${s.worstMs} ms`);
  console.log(`  pacing jitter ${s.jitterMs} ms · ${s.hitches33} frames >33 ms · ${s.hitches50} >50 ms`);
}

main().catch((e) => { console.error(e); devProc?.kill(); process.exit(1); });
