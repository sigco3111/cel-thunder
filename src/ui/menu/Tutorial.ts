import { el, setClass, setText, setStyle } from '../dom';
import { sfx } from '../sfx';
import { axisLabel, primaryLabel, type BindingSet } from '../../engine/input/bindings';

/**
 * Flight school — the thirty seconds that decide whether a new player ever
 * flies a second sortie.
 *
 * ## Why it is interactive rather than a slideshow
 *
 * A card that says "A and D roll the aeroplane" is read, agreed with, and
 * forgotten before the reader's hands have moved. A prompt that says "roll the
 * aeroplane" and refuses to go away until the wings have actually gone past
 * thirty degrees teaches the control, because the player has *done* it. Every
 * step below therefore completes on a measured change in the world — pointer
 * lock actually taken, the throttle actually moved, the nose actually raised —
 * and not on a keypress, a timer or a Next button.
 *
 * The very first step is "click to take the controls", and it is first for a
 * reason: without pointer lock the mouse is not connected to the aeroplane at
 * all, and every later step would be teaching a control the player does not
 * have. That was the state the game shipped in.
 *
 * ## Why it never blocks
 *
 * The overlay is 'pointer-events: none' except for the Skip button, it never
 * emits 'ui:modal', and it never suspends the input subsystem. Three reasons,
 * all of them things that went wrong in something like it before:
 *
 *   - a modal would swallow the click that takes pointer lock, so the tutorial
 *     would deadlock on its own first instruction;
 *   - the player is *flying* during all of this. An aeroplane that stops
 *     responding because a tooltip is up is worse than no tutorial;
 *   - the automated harnesses fly the game through the same front door. A
 *     tutorial that gated their input would fail every playability check, and a
 *     tutorial that cannot be tested is a tutorial that will break.
 *
 * ## Why it cannot softlock
 *
 * Every step auto-advances after 'AUTO_MS'. A player who cannot work out what
 * is being asked — or one whose gamepad has died, or who is being shot at —
 * gets carried forward rather than stranded, with the step marked as skipped
 * rather than passed.
 */

const SEEN_KEY = 'celthunder.tutorial.v1';
/** Idle time before a step gives up and moves the player on. */
const AUTO_MS = 13;
/** When the "this will move on by itself" reassurance appears. */
const NUDGE_MS = 8.5;

/** Everything a step needs to know about the world, sampled once per frame. */
export interface TutorialProbe {
  /** Pointer lock is held. */
  locked: boolean;
  /** Pointer lock has been refused by this browser — step 1 cannot be passed. */
  lockUnavailable: boolean;
  /** A throttle key is down this frame. */
  throttleKey: boolean;
  /** Commanded throttle, 0…1. */
  throttle: number;
  /** A trigger is down this frame. */
  firing: boolean;
  /** Current camera rig name, for the "change camera" step. */
  cameraMode: string;
  /** Attitude, degrees. */
  pitchDeg: number;
  bankDeg: number;
  /** True while the player is alive and in the air. */
  flying: boolean;
}

interface Step {
  id: string;
  /** Short imperative — what to do. */
  title: string;
  /** The keys involved, resolved from the live bindings. */
  keys: (b: BindingSet) => string[];
  /** One line of why. */
  why: string;
  /**
   * Returns true once the step has been satisfied. 'base' is the probe as it
   * was when the step started, so a step can ask for a *change* rather than an
   * absolute value — which is the only way "raise the nose" can be tested on an
   * aeroplane that might have started the step in a dive.
   */
  done: (p: TutorialProbe, base: TutorialProbe, held: number) => boolean;
}

const bank = (d: number): number => Math.abs(((d + 540) % 360) - 180);

const STEPS: Step[] = [
  {
    id: 'capture',
    title: 'Click anywhere to take the controls',
    keys: () => ['Click'],
    why: 'The mouse aims the aeroplane. Until you click, the game has not got it.',
    done: (p) => p.locked || p.lockUnavailable,
  },
  {
    id: 'throttle',
    title: 'Open the throttle',
    keys: (b) => axisLabel(b, ['throttleUp', 'throttleDown']).split(' / '),
    why: 'Speed is life. Hold it open to climb and to fight.',
    // Held rather than instantaneous: the aircraft spawns at full power, so
    // "throttle is high" would pass before the player had touched anything.
    done: (_p, _b, held) => held > 0.35,
  },
  {
    id: 'pitch',
    title: 'Move the mouse back to raise the nose',
    keys: (b) => ['Mouse', ...axisLabel(b, ['pitchUp']).split(' / ')],
    why: 'The mouse flies the aeroplane. It goes where the reticle points — '
      + 'the keys are there if you prefer them, but you will not need them.',
    done: (p, base) => p.pitchDeg - base.pitchDeg > 9,
  },
  {
    id: 'roll',
    title: 'Move the mouse sideways to turn',
    keys: (b) => ['Mouse', ...axisLabel(b, ['rollLeft', 'rollRight']).split(' / ')],
    why: 'Mouse right banks right and turns right. Aeroplanes turn by leaning '
      + 'into it, so the wings go over first and the nose follows.',
    done: (p, base) => bank(p.bankDeg - base.bankDeg) > 28,
  },
  {
    id: 'recover',
    // The most important thing a first-time pilot can know, and the one thing
    // that stops a bad attitude becoming a crash: there is always a way out and
    // it costs no skill at all.
    title: 'Now stop moving the mouse',
    keys: () => ['Let go'],
    why: 'Take your hand off and the aeroplane levels its wings, brings the '
      + 'nose to the horizon and flies straight. Whatever goes wrong, letting '
      + 'go fixes it.',
    done: (p) => bank(p.bankDeg) < 10 && Math.abs(p.pitchDeg) < 10,
  },
  {
    id: 'fire',
    title: 'Fire the guns',
    keys: (b) => axisLabel(b, ['fire1', 'fire2']).split(' / '),
    why: 'Short bursts. The reticle is where the rounds go.',
    done: (_p, _b, held) => held > 0.25,
  },
  {
    id: 'camera',
    title: 'Change the camera',
    keys: (b) => [primaryLabel(b, 'cameraCycle')],
    why: 'Chase, cockpit and gunsight views. Use whichever you can fly in.',
    done: (p, base) => p.cameraMode !== base.cameraMode,
  },
];

export class Tutorial {
  readonly root: HTMLElement;
  private stepBox: HTMLElement;
  private titleNode: HTMLElement;
  private keysNode: HTMLElement;
  private whyNode: HTMLElement;
  private nudgeNode: HTMLElement;
  private pipsNode: HTMLElement;
  private skipBtn: HTMLButtonElement;
  private tickNode: HTMLElement;

  private bindings: BindingSet | null = null;
  private active = false;
  private index = 0;
  private elapsed = 0;
  private held = 0;
  private base: TutorialProbe | null = null;
  /** Brief pause on a completed step so the tick is actually seen. */
  private celebrate = 0;

  /** Fired when the tutorial ends, with whether the player saw it through. */
  onEnd: (completed: boolean) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ct-tut ct-hidden', parent);
    this.stepBox = el('div', 'ct-tut-card ct-panel is-glass is-deep', this.root);

    const head = el('div', 'ct-tut-head', this.stepBox);
    el('div', 'ct-tut-kicker', head, 'Flight school');
    this.pipsNode = el('div', 'ct-tut-pips', head);

    this.titleNode = el('div', 'ct-tut-title', this.stepBox, '');
    this.keysNode = el('div', 'ct-tut-keys', this.stepBox);
    this.whyNode = el('div', 'ct-tut-why', this.stepBox, '');
    this.nudgeNode = el('div', 'ct-tut-nudge', this.stepBox, '');
    this.tickNode = el('div', 'ct-tut-tick', this.stepBox, 'Good');

    const foot = el('div', 'ct-tut-foot', this.stepBox);
    this.skipBtn = el('button', 'ct-btn is-ghost is-sm ct-tut-skip', foot, 'Skip') as HTMLButtonElement;
    this.skipBtn.addEventListener('click', (e) => {
      // The click must not also reach the canvas and take pointer lock — the
      // player asked to leave, not to start flying.
      e.stopPropagation();
      this.finish(false);
    });
  }

  static isFirstEver(): boolean {
    try { return localStorage.getItem(SEEN_KEY) !== '1'; } catch { return false; }
  }

  private static markSeen(): void {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
  }

  /** Clears the "already seen" flag, so the menu can replay it. */
  static replay(): void {
    try { localStorage.removeItem(SEEN_KEY); } catch { /* private mode */ }
  }

  setBindings(b: BindingSet | null): void { this.bindings = b; }

  /**
   * Starts the tutorial.
   *
   * @param force  run it even for a player who has already been through it.
   * @returns whether it actually started.
   */
  start(force = false): boolean {
    if (this.active) return true;
    if (!force && !Tutorial.isFirstEver()) return false;
    if (!this.bindings) return false;
    this.active = true;
    this.index = 0;
    this.elapsed = 0;
    this.held = 0;
    this.celebrate = 0;
    this.base = null;
    setClass(this.root, 'ct-hidden', false);
    this.paint();
    return true;
  }

  /** Ends the tutorial. Marks it seen either way — it does not nag. */
  finish(completed: boolean): void {
    if (!this.active) return;
    this.active = false;
    Tutorial.markSeen();
    setClass(this.root, 'ct-hidden', true);
    sfx(completed ? 'ui:confirm' : 'ui:back');
    this.onEnd(completed);
  }

  get isActive(): boolean { return this.active; }

  /** Esc skips. Returns true if the key was consumed. */
  handleEscape(): boolean {
    if (!this.active) return false;
    this.finish(false);
    return true;
  }

  update(dt: number, p: TutorialProbe): void {
    if (!this.active) return;
    const step = STEPS[this.index];
    if (!step) { this.finish(true); return; }

    // The clock does not run until the player is actually flying, so a slow
    // spawn or a respawn cannot burn through a step the player never saw.
    if (!p.flying && step.id !== 'capture') return;

    if (this.celebrate > 0) {
      this.celebrate -= dt;
      if (this.celebrate <= 0) this.advance(p);
      return;
    }

    if (!this.base) { this.base = { ...p }; this.elapsed = 0; this.held = 0; }
    this.elapsed += dt;

    // Held-input steps accumulate; everything else reads the world directly.
    if (step.id === 'throttle' && p.throttleKey) this.held += dt;
    else if (step.id === 'fire' && p.firing) this.held += dt;

    if (step.done(p, this.base, this.held)) {
      setClass(this.stepBox, 'is-done', true);
      setStyle(this.nudgeNode, 'display', 'none');
      sfx('ui:confirm');
      this.celebrate = 0.85;
      return;
    }

    if (this.elapsed > AUTO_MS) { this.advance(p); return; }
    const nudge = this.elapsed > NUDGE_MS;
    setStyle(this.nudgeNode, 'display', nudge ? '' : 'none');
    if (nudge) {
      setText(this.nudgeNode,
        `Moving on in ${Math.max(1, Math.ceil(AUTO_MS - this.elapsed))}s — no need to get it now`);
    }
    // Progress ring on the current pip.
    const pip = this.pipsNode.children[this.index] as HTMLElement | undefined;
    if (pip) setStyle(pip, '--p', `${Math.min(100, (this.elapsed / AUTO_MS) * 100)}%`);
  }

  private advance(p: TutorialProbe): void {
    setClass(this.stepBox, 'is-done', false);
    this.index++;
    this.base = { ...p };
    this.elapsed = 0;
    this.held = 0;
    if (this.index >= STEPS.length) { this.finish(true); return; }
    this.paint();
  }

  private paint(): void {
    const b = this.bindings;
    const step = STEPS[this.index];
    if (!b || !step) return;

    setText(this.titleNode, step.title);
    setText(this.whyNode, step.why);
    setStyle(this.nudgeNode, 'display', 'none');

    this.keysNode.textContent = '';
    for (const k of step.keys(b)) {
      if (k && k !== '—') el('kbd', 'ct-kbd', this.keysNode, k);
    }

    // Skip affordance depends on whether the player can reach a button: once
    // the pointer is captured there is no cursor to click with, so say so.
    setText(this.skipBtn, this.index === 0 ? 'Skip' : 'Skip  ·  Esc');

    if (this.pipsNode.children.length !== STEPS.length) {
      this.pipsNode.textContent = '';
      for (let i = 0; i < STEPS.length; i++) el('i', 'ct-tut-pip', this.pipsNode);
    }
    for (let i = 0; i < STEPS.length; i++) {
      const pip = this.pipsNode.children[i] as HTMLElement;
      setClass(pip, 'is-done', i < this.index);
      setClass(pip, 'is-now', i === this.index);
      if (i !== this.index) setStyle(pip, '--p', '0%');
    }
  }
}
