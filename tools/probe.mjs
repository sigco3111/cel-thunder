/**
 * Fast A/B probe for the art-direction loop.
 *
 * Loads the game once and then captures N variants of the SAME framing, each
 * preceded by an arbitrary JS snippet evaluated in the page. That makes
 * "what is this pass actually costing me?" a 20-second question instead of a
 * source-edit / reload / 40-second-warmup one.
 *
 *   node tools/probe.mjs --framing hero --variants "base:;nodof:__g.render.setPassEnabled('dof',false)"
 *
 * Variant syntax is `name:javascript`, separated by `;;`. Inside the snippet
 * `__g` is `window.__game`, `__r` is the render subsystem and `__s` the sky.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const OUT = arg('out', 'shots/probe');
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const URL_BASE = arg('url', 'http://localhost:5233');
const FRAMINGS = arg('framing', 'hero').split(',').filter(Boolean);
const WARMUP = parseInt(arg('warmup', '9000'), 10);
const SETTLE = parseInt(arg('settle', '2200'), 10);
const VARIANTS = arg('variants', 'base:').split(';;').filter(Boolean).map((v) => {
  const i = v.indexOf(':');
  return { name: v.slice(0, i), code: v.slice(i + 1) };
});

const PIN_PAGE = () => {
  const Native = window.WebSocket;
  const isHmr = (p) => p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'));
  const dead = () => ({
    readyState: 0, url: '', protocol: '', extensions: '', bufferedAmount: 0, binaryType: 'blob',
    onopen: null, onclose: null, onerror: null, onmessage: null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    send() {}, close() {},
  });
  window.WebSocket = new Proxy(Native, {
    construct(t, a) { return isHmr(a[1]) ? dead() : Reflect.construct(t, a); },
  });
};

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.addInitScript(PIN_PAGE);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));

  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__ready === true', { timeout: 90000 });
  await sleep(WARMUP);

  for (const framing of FRAMINGS) {
    for (const v of VARIANTS) {
      await page.evaluate((name) => window.__game.get('camera').debugFraming(name), framing);
      if (v.code.trim()) {
        const r = await page.evaluate((code) => {
          const __g = window.__game;
          const __r = __g.get('render');
          const __s = __g.get('sky');
          try { // eslint-disable-next-line no-eval
            return String((0, eval)(`(function(__g,__r,__s){${code}})`)(__g, __r, __s));
          } catch (e) { return 'ERR ' + e.message; }
        }, v.code);
        if (r && r !== 'undefined') console.log(`  · ${v.name}: ${r}`);
      }
      await sleep(SETTLE);
      const path = `${OUT}/${framing}__${v.name}.png`;
      await page.screenshot({ path });
      console.log(`[probe] ${path}`);
    }
  }
  if (errors.length) console.log(`[probe] ${errors.length} console error(s):\n  ` + [...new Set(errors)].slice(0, 6).join('\n  '));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
