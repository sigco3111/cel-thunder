import { Game } from './engine/Game';
import type { Subsystem } from './engine/context';
import { t } from './i18n';
import { applyLocalizationToTheme } from './ui/theme';
import { RenderSystem } from './render/RenderSystem';
import { SkySystem } from './render/sky/SkySystem';
import { WorldSystem } from './world/WorldSystem';
import { EntitySystem } from './game/EntitySystem';
import { FlightSystem } from './game/FlightSystem';
import { NetSystem } from './net/NetSystem';
import { InputSystem } from './engine/InputSystem';
import { CameraSystem } from './engine/CameraSystem';
import { VfxSystem } from './vfx/VfxSystem';
import { AudioSystem } from './audio/AudioSystem';
import { UiSystem } from './ui/UiSystem';

const boot = document.getElementById('boot');
const bootBar = document.getElementById('boot-bar');
const bootMsg = document.getElementById('boot-msg');

/**
 * Hard ceiling on the whole boot. 'Game.init' already bounds each subsystem
 * individually, so this only fires if something outside that loop wedges — but
 * a loading screen that never goes away is the single worst failure mode this
 * game has, so it gets a second, independent net.
 */
const BOOT_WATCHDOG_MS = 45000;

let bootDismissed = false;
function dismissBoot(): void {
  if (bootDismissed || !boot) return;
  bootDismissed = true;
  boot.style.opacity = '0';
  boot.style.pointerEvents = 'none';
  setTimeout(() => boot.remove(), 700);
}

function setProgress(frac: number, msg: string): void {
  if (bootBar) bootBar.style.width = `${Math.round(frac * 100)}%`;
  if (bootMsg) bootMsg.textContent = msg;
}

/**
 * Fault injection for the degraded-boot path, driven by the query string:
 *
 *   ?failSubsystems=audio,vfx   their 'init' throws
 *   ?hangSubsystems=world       their 'init' never settles
 *
 * The whole point of 'Game.init' containing subsystem failures is that a
 * broken subsystem cannot wedge the boot — and a recovery path nobody can
 * exercise is a recovery path nobody knows is broken. This makes the claim
 * testable from the screenshot harness in one line, and costs a string compare
 * per subsystem at boot.
 */
function faultInject<T extends Subsystem>(sys: T): T {
  const params = new URLSearchParams(location.search);
  const listed = (key: string) =>
    (params.get(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(sys.name);

  // Shadow the prototype's 'init' with an own property, so the instance is
  // otherwise untouched and still identical to the real subsystem.
  const shadow = sys as unknown as { init: () => void | Promise<void> };
  if (listed('failSubsystems')) {
    shadow.init = () => { throw new Error('injected failure'); };
  } else if (listed('hangSubsystems')) {
    shadow.init = () => new Promise<void>(() => { /* deliberately never settles */ });
  }
  return sys;
}

async function main() {
  const container = document.getElementById('app')!;
  // Activate the Korean theme labels BEFORE UiSystem or any UI module reads
  // NATION_LABEL / ROLE_LABEL; theme.ts mutates those records in place and
  // has already had its i18n dict installed by import time.
  applyLocalizationToTheme();
  const game = new Game(container);

  // Published before init so the harness (and a human with devtools) can see a
  // boot in progress rather than an undefined global.
  (window as any).__game = game;

  // Order matters: each subsystem may read state produced by the previous one
  // within the same frame.
  // Registration order is both the init order and the per-frame update order.
  //
  // Data providers must initialise before their consumers: the sky publishes
  // sun state, and the world publishes the terrain height field that input,
  // flight, VFX and the camera all sample — including during their own init.
  //
  // Within a frame the ordering constraint is different: input must run before
  // flight, or the prediction step consumes last frame's controls and the whole
  // aircraft feels a frame behind the mouse. Both constraints are satisfiable
  // at once, which is why this exact sequence matters.
  for (const sys of [
    new NetSystem(),        // pulls snapshots, owns the entity map
    new SkySystem(),        // sun position, atmosphere, clouds
    new WorldSystem(),      // terrain, water, airfields — queried by everyone below
    new InputSystem(),      // samples devices, produces InputFrame
    new FlightSystem(),     // local prediction + reconciliation
    new EntitySystem(),     // spawns/updates visual representations
    new VfxSystem(),        // particles, tracers, explosions
    new CameraSystem(),     // chase/cockpit rigs
    new AudioSystem(),      // spatial audio
    new UiSystem(),         // HUD + menus
    new RenderSystem(),     // composer, must be last
  ]) game.register(faultInject(sys));

  const watchdog = setTimeout(() => {
    console.error('[boot] watchdog fired — dismissing the loading screen anyway');
    dismissBoot();
    (window as any).__ready = true;
  }, BOOT_WATCHDOG_MS);

  await game.init(setProgress);
  clearTimeout(watchdog);

  game.start();

  if (game.failedSubsystems.length) {
    const names = game.failedSubsystems.map((f) => f.name).join(', ');
    console.error(`[boot] running DEGRADED — skipped subsystem(s): ${names}`);
    setProgress(1, t('bootReadySkipped', { names }));
    if (bootMsg) bootMsg.style.color = '#ffc247';
  }

  dismissBoot();

  // Expose for the automated visual-critique harness.
  (window as any).__ready = true;
}

main().catch((err) => {
  // Reaching here means the failure was outside any subsystem's init — a bad
  // import, a missing DOM node, a dead WebGL context. Say so on screen; the
  // canvas behind is not going to render anything useful.
  console.error('[boot] fatal', err);
  if (bootMsg) {
    bootMsg.textContent = t('bootFailed', { msg: err?.message ?? err });
    bootMsg.style.color = '#ff6b6b';
  }
  // Still flip the flag: a harness blocked forever on '__ready' produces no
  // diagnostics at all, whereas one that proceeds captures the error screen.
  (window as any).__ready = true;
});
