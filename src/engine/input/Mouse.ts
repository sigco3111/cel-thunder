import { t } from '../../i18n';

/**
 * Mouse device + pointer-lock flow.
 *
 * Two modes, and the aim controller works with either:
 *
 *  - **Locked** (the normal case): the OS cursor is captured and we integrate
 *    raw 'movementX/Y'. This is the only way to get unbounded travel, which
 *    mouse-aim flight needs — the reticle must be able to keep moving after the
 *    pointer would have hit the edge of the window.
 *  - **Unlocked fallback**: the reticle follows the actual cursor position
 *    inside the canvas ('nx'/'ny', consumed by InputSystem.updateAiming through
 *    MouseAimController.fromWireAim). Used before the player has clicked, and in
 *    every browser or embedding where pointer lock is denied. It stays inert
 *    until the cursor has genuinely moved over the canvas, so a headless capture
 *    keeps the reticle boresighted rather than pinning it to a corner.
 *
 * Browsers reject 'requestPointerLock' outside a user gesture and rate-limit
 * re-locking for about a second after Escape, so the request is always driven
 * by a real click and failures are silently retried on the next one.
 */
export class Mouse {
  /** Accumulated raw movement since the last drain, in device pixels. */
  dx = 0;
  dy = 0;
  /** Cursor position in normalised device coords, [-1,1], +Y up. */
  nx = 0;
  ny = 0;
  /**
   * True once the cursor has actually moved inside the canvas while unlocked.
   *
   * The absolute path must not take over until then, or a page that has never
   * seen the mouse (the screenshot harness, or a player who is still reading the
   * menu) would have its reticle yanked to wherever the OS happened to leave the
   * pointer, which on a headless capture is the top-left corner.
   */
  movedUnlocked = false;
  /** Wheel notches since the last drain (positive = scroll up / zoom in). */
  wheel = 0;
  /** Codes: 'Mouse0' (left) … 'Mouse4'. */
  readonly codes = new Set<string>();
  locked = false;
  /** True once the player has locked at least once — suppresses the prompt nag. */
  hasLocked = false;
  /**
   * True when this browser has been *asked* for pointer lock and refused, and
   * has never granted it.
   *
   * This is the switch that decides whether the absolute-cursor fallback is
   * allowed to fly the aeroplane at all (see 'InputSystem.updateAiming'). It has
   * to be earned by a real refusal rather than assumed from "not locked right
   * now", because those two states want opposite behaviour:
   *
   *   not locked, but lock works here — the player has not taken the controls
   *     yet, or has just pressed Escape. The cursor is wherever they last left
   *     it (on the Deploy button, in the corner, over another window) and it
   *     means nothing. Flying to it is what made the aeroplane "jittery and
   *     moving around": parked off-centre, the reticle pins to the cone edge and
   *     the director holds a max-rate turn forever. Measured, cursor at the
   *     bottom-right corner gave conePull = 1.00 indefinitely.
   *
   *   lock genuinely refused — an embedded frame, an unusual browser, the test
   *     harness. Now the cursor is the only pointing device there is, and
   *     following it is the only way the game is playable at all.
   *
   * Once a lock has succeeded we know the capability exists, so a later failure
   * (Chrome rate-limits re-locking for ~1.25 s after an Escape) is transient and
   * must not switch the fallback on.
   *
   * A *single* refusal is not proof either, and treating it as proof is what the
   * player reported as "the mouse is always not focused on the game". Chromium
   * rejects 'requestPointerLock' outright when the document does not have OS
   * focus — which is precisely the state a player is in when they alt-tab back
   * to the game and click: that first click is spent focusing the window, the
   * lock is refused, and the old code concluded the browser could not capture at
   * all and handed the aeroplane to the bare cursor forever. So this now needs
   * 'DENY_AFTER' refusals in a row, and the prompt asks for the focus click in
   * between.
   */
  lockDenied = false;
  /** How many times the game has asked for the capture this session. */
  lockRequests = 0;
  /** Consecutive refusals since the last successful capture. */
  lockErrors = 0;
  /**
   * The last refusal happened while the document did not have focus — so the
   * fix is a click to focus the window, not a different browser.
   */
  lockNeedsFocus = false;

  private el: HTMLElement | null = null;
  private prompt: HTMLElement | null = null;
  private promptVisible = false;
  private wantLock = false;
  private lastLockAttempt = 0;
  private bound = false;

  attach(target: HTMLElement): void {
    if (this.bound) return;
    this.bound = true;
    this.el = target;

    // A canvas is not focusable by default, so clicking it moves DOM focus to
    // the document body — or nowhere at all — and 'element.focus()' is a no-op.
    // Chromium will not grant pointer lock to an unfocused document, so making
    // the canvas a real focus target is a precondition for the capture, not a
    // nicety.
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.style.outline = 'none';

    target.addEventListener('mousedown', this.onDown);
    addEventListener('focus', this.onWindowFocus);
    addEventListener('mouseup', this.onUp);
    addEventListener('mousemove', this.onMove);
    target.addEventListener('wheel', this.onWheel, { passive: false });
    target.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', this.onLockError);
    addEventListener('blur', this.clearButtons);

    this.buildPrompt();
  }

  detach(): void {
    if (!this.bound) return;
    this.bound = false;
    const target = this.el;
    target?.removeEventListener('mousedown', this.onDown);
    removeEventListener('focus', this.onWindowFocus);
    removeEventListener('mouseup', this.onUp);
    removeEventListener('mousemove', this.onMove);
    target?.removeEventListener('wheel', this.onWheel);
    target?.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockError);
    removeEventListener('blur', this.clearButtons);
    this.prompt?.remove();
    this.prompt = null;
    this.el = null;
  }

  // -------------------------------------------------------------------------

  private onDown = (e: MouseEvent): void => {
    this.codes.add(`Mouse${e.button}`);
    if (e.button === 1) e.preventDefault();          // middle-click autoscroll
    if (this.wantLock && !this.locked) {
      // Focus first, synchronously, inside the gesture. A click that lands on
      // the canvas while the *document* is unfocused is the case Chromium
      // rejects, and it is the ordinary real-world case: the player alt-tabs
      // back and clicks, and that click is spent focusing rather than locking.
      // Taking the focus ourselves means the very same click can then lock, and
      // if the browser still says no, the second click of a double-click will —
      // which is exactly the gesture the player already tries.
      this.takeFocus();
      this.requestLock();
    }
  };

  /**
   * Pulls window and DOM focus onto the canvas. Must be called from inside a
   * user gesture and before 'requestPointerLock', never after.
   */
  private takeFocus(): void {
    try { window.focus(); } catch { /* cross-origin frame */ }
    try { this.el?.focus({ preventScroll: true }); } catch { /* not focusable */ }
  }

  /**
   * The window has come back. The capture cannot be retaken here — pointer lock
   * needs a gesture and this is not one — but the prompt was very possibly
   * showing the wrong thing, so let it re-read the situation.
   */
  private onWindowFocus = (): void => {
    if (this.lockNeedsFocus) { this.lockNeedsFocus = false; this.syncPrompt(); }
  };

  private onUp = (e: MouseEvent): void => { this.codes.delete(`Mouse${e.button}`); };

  private onMove = (e: MouseEvent): void => {
    if (this.locked) {
      this.dx += e.movementX;
      this.dy += e.movementY;
    } else if (this.el) {
      const r = this.el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        this.nx = ((e.clientX - r.left) / r.width) * 2 - 1;
        this.ny = 1 - ((e.clientY - r.top) / r.height) * 2;
        // Only inside the canvas: a cursor parked over a menu panel is not
        // aiming the aeroplane.
        if (Math.abs(this.nx) <= 1 && Math.abs(this.ny) <= 1) this.movedUnlocked = true;
      }
    }
  };

  private onWheel = (e: WheelEvent): void => {
    // deltaMode 0 = pixels, 1 = lines, 2 = pages. Normalise to "notches".
    const scale = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 1 : 1 / 100;
    this.wheel -= e.deltaY * scale;
    e.preventDefault();
  };

  private onContextMenu = (e: Event): void => { e.preventDefault(); };

  private clearButtons = (): void => { this.codes.clear(); };

  private onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.el;
    if (this.locked) {
      this.hasLocked = true;
      this.lockDenied = false;
      this.lockErrors = 0;
      this.lockNeedsFocus = false;
      this.dx = 0; this.dy = 0;
      // Coming back out of lock, the OS restores the cursor to wherever it was
      // when we captured it; that stale position must not snap the reticle.
      this.movedUnlocked = false;
    }
    this.syncPrompt();
  };

  private onLockError = (): void => {
    this.locked = false;
    this.noteDenied();
    this.syncPrompt();
  };

  /**
   * Records a refused lock.
   *
   * See 'lockDenied' for why 'hasLocked' gates it and why one refusal is not
   * enough. The refusal is attributed to focus whenever the document did not
   * have it, because that is both the commonest cause and the only one the
   * player can do anything about.
   */
  private noteDenied(): void {
    this.lockErrors++;
    let focused = true;
    try { focused = document.hasFocus(); } catch { /* sandboxed */ }
    this.lockNeedsFocus = !focused;
    if (!this.hasLocked && this.lockErrors >= DENY_AFTER) this.lockDenied = true;
  }

  /**
   * Makes the unlocked absolute-cursor path inert again until the player
   * genuinely moves the mouse.
   *
   * Called on spawn. Without it the cursor is still sitting wherever the player
   * left it — on the Deploy button, low and to one side — and because that
   * position *is* the reticle in the unlocked fallback, the flight director
   * reads it as a standing command and bunts the aeroplane into a diving turn
   * the instant it appears in the world.
   */
  releaseAbsoluteAim(): void { this.movedUnlocked = false; }

  /** Tells the mouse whether the current game state wants the pointer captured. */
  setCaptureDesired(want: boolean): void {
    if (this.wantLock === want) return;
    this.wantLock = want;
    if (!want && this.locked) document.exitPointerLock();
    this.syncPrompt();
  }

  /**
   * Hides the prompt without giving up the capture request. Used by the
   * cinematic camera framings: the screenshot harness never clicks, so the
   * prompt would otherwise sit across every beauty shot.
   */
  setPromptSuppressed(v: boolean): void {
    if (this.promptSuppressed === v) return;
    this.promptSuppressed = v;
    this.syncPrompt();
  }
  private promptSuppressed = false;

  /**
   * Second, independent suppression, owned by the tutorial.
   *
   * Flight school's first instruction is "click anywhere to take the controls",
   * in a larger panel, in the same corner of the screen — two overlapping boxes
   * saying the same sentence. This mutes the smaller one for the duration.
   *
   * Kept separate from 'promptSuppressed' rather than sharing it because that
   * flag belongs to the screenshot harness, and a tutorial that ended by
   * clearing it would put the prompt back across every beauty shot.
   */
  setPromptMuted(v: boolean): void {
    if (this.promptMuted === v) return;
    this.promptMuted = v;
    this.syncPrompt();
  }
  private promptMuted = false;

  /**
   * Whether 'unadjustedMovement' has been proven to work here.
   * undefined = untried, true/false = decided. Sticky for the session.
   */
  private static rawMovementSupported: boolean | undefined;

  requestLock(): void {
    const now = performance.now();
    // Chrome throws a SecurityError if a request lands within ~1.25 s of an
    // Escape-triggered exit, so requests are rate-limited — but the limit must
    // NOT swallow the second half of a double-click, which is exactly how most
    // players try to capture the mouse. 120 ms is long enough to stop a held
    // button spamming the API and short enough that a double-click's second
    // press still gets a real attempt if the first was denied.
    if (now - this.lastLockAttempt < 120) return;
    this.lastLockAttempt = now;

    const el = this.el;
    const req = (el as unknown as { requestPointerLock?: (o?: unknown) => unknown })?.requestPointerLock;
    if (!el || !req) return;
    this.lockRequests++;
    // Belt and braces: 'requestLock' is also reachable from the Deploy button's
    // click handler, which is a gesture on a *different* element, so the canvas
    // may still not hold focus by the time we get here.
    this.takeFocus();

    // 'unadjustedMovement' asks for raw, un-accelerated deltas — much better for
    // aiming, and Chromium-only.
    //
    // The subtlety that made this fail outright: pointer lock must be requested
    // from inside a user gesture. The previous version requested it WITH the
    // option and, if the returned promise rejected, retried without it inside
    // the '.catch()' — which runs on a later microtask, by which point the
    // gesture has expired and the retry is rejected too. The result was a game
    // that never captured the mouse on any browser that dislikes the option,
    // and, because mouse-aim then falls back to absolute cursor position, a
    // flight director that spent every frame chasing an off-centre reticle.
    //
    // So: only pass the option once we know it works, and when we do not know,
    // make the plain request — synchronously, inside the gesture — and probe
    // for support separately.
    const useRaw = Mouse.rawMovementSupported === true;
    try {
      const p = useRaw ? req.call(el, { unadjustedMovement: true }) : req.call(el);
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => {
          // A denied lock is an expected outcome (no gesture, too soon after an
          // Escape, an unsupported embedding), not a fault. Do NOT retry here —
          // see above. The prompt stays up and the next click tries again.
          if (useRaw) Mouse.rawMovementSupported = false;
          this.noteDenied();
        });
      }
      // First successful plain lock: find out whether raw movement is available
      // for next time, without risking this attempt.
      if (Mouse.rawMovementSupported === undefined) {
        Mouse.rawMovementSupported = typeof (navigator as { userAgentData?: unknown }).userAgentData !== 'undefined';
      }
    } catch {
      if (useRaw) Mouse.rawMovementSupported = false;
      this.noteDenied();
      // Denied — the prompt stays up and the next click retries.
    }
  }

  /** Returns the movement accumulated since the last call and resets it. */
  drain(out: { dx: number; dy: number; wheel: number }): void {
    out.dx = this.dx; out.dy = this.dy; out.wheel = this.wheel;
    this.dx = 0; this.dy = 0; this.wheel = 0;
  }

  // -------------------------------------------------------------------------
  // Prompt overlay
  // -------------------------------------------------------------------------

  /**
   * The "click to fly" call to action.
   *
   * This used to be a 12 px line of letter-spaced caps at the very bottom of
   * the frame, which is where a game puts things it does not mind you missing.
   * The player missed it, never captured the mouse, and spent the session
   * fighting an aeroplane that was chasing their cursor — so the prompt is now
   * sized and animated like the instruction it is: centred low, a mouse glyph,
   * a breathing ring, and the canvas itself switches to a pointer cursor so the
   * "this is clickable" signal exists even for someone reading nothing.
   */
  private buildPrompt(): void {
    if (!document.getElementById('ct-lock-prompt-css')) {
      const css = document.createElement('style');
      css.id = 'ct-lock-prompt-css';
      css.textContent = `
@keyframes ct-lockpulse {
  0%,100% { transform: scale(1);    opacity: .55; }
  50%     { transform: scale(1.14); opacity: .12; }
}
/* Transform only — deliberately.
   A CSS animation wins over an inline style, and this one runs with
   'fill: both', so a keyframe that touched opacity would pin the prompt's
   opacity at its final value forever: the panel then stayed lit through the
   pause menu, over the settings modal and after the mouse had been captured,
   because 'style.opacity = "0"' was being silently outranked. Visibility is the
   inline transition's job; this only supplies the rise. */
@keyframes ct-lockrise {
  from { transform: translate(-50%, 10px); }
  to   { transform: translate(-50%, 0); }
}
#ct-lock-prompt { animation: ct-lockrise .34s cubic-bezier(.2,.8,.3,1) both; }
#ct-lock-prompt .ct-lp-ring {
  position: absolute; inset: -6px; border-radius: 10px;
  border: 2px solid rgba(255,207,107,.85);
  animation: ct-lockpulse 1.9s ease-in-out infinite;
  pointer-events: none;
}
#ct-lock-prompt .ct-lp-mouse {
  width: 15px; height: 23px; border-radius: 8px;
  border: 2px solid rgba(255,207,107,.95);
  position: relative; flex: 0 0 auto;
}
#ct-lock-prompt .ct-lp-mouse::after {
  content: ''; position: absolute; left: 50%; top: 3px;
  width: 2px; height: 6px; margin-left: -1px; border-radius: 1px;
  background: rgba(255,207,107,.95);
}`;
      document.head.appendChild(css);
    }

    const el = document.createElement('div');
    el.id = 'ct-lock-prompt';
    el.setAttribute('role', 'status');
    // Inline styles for the box itself: there is no stylesheet to depend on and
    // this must render correctly on the very first frame, before any UI system
    // has initialised.
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:17%', 'transform:translateX(-50%)',
      'z-index:60', 'pointer-events:none', 'opacity:0',
      'transition:opacity .28s ease',
      'display:flex', 'align-items:center', 'gap:13px',
      'font:600 15px/1.25 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif',
      'color:#eef4fb',
      'padding:14px 22px',
      'background:linear-gradient(180deg,rgba(9,14,22,.92),rgba(9,14,22,.78))',
      'border:1px solid rgba(190,215,240,.34)',
      'border-radius:4px',
      'box-shadow:0 6px 34px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.07)',
      'text-shadow:0 1px 2px rgba(0,0,0,.8)',
      'backdrop-filter:blur(4px)',
      'white-space:nowrap',
    ].join(';');
    el.innerHTML = PROMPT_INVITE();
    document.body.appendChild(el);
    this.prompt = el;
    this.syncPrompt();
  }

  private promptMode: '' | 'invite' | 'focus' | 'denied' = '';

  private syncPrompt(): void {
    if (!this.prompt) return;
    const show = this.wantLock && !this.locked && !this.promptSuppressed && !this.promptMuted;
    // Three different things to say, and telling a player the wrong one is
    // worse than silence.
    //
    //   invite  capture is available and untried — "click to take the controls".
    //   focus   the browser refused, and it refused because the window did not
    //           have focus. This is the state the player described as "the mouse
    //           is always not focused on the game", and it used to render as
    //           either a lie ("click to take the controls", which then does
    //           nothing) or a shrug ("this browser will not capture the mouse",
    //           which is false and gives up on their behalf). Tell them the one
    //           thing that actually works.
    //   denied  refused repeatedly with the window focused: this embedding
    //           genuinely cannot capture, and the cursor really is the aim.
    const mode = !show ? ''
      : this.lockDenied ? 'denied'
        : this.lockErrors > 0 ? 'focus'
          : 'invite';
    if (this.el) this.el.style.cursor = mode === 'denied' ? '' : 'pointer';
    if (mode !== this.promptMode) {
      this.promptMode = mode;
      if (mode) {
        this.prompt.innerHTML = mode === 'denied' ? PROMPT_DENIED()
          : mode === 'focus' ? PROMPT_FOCUS()
            : PROMPT_INVITE();
      }
    }
    const useful = mode !== '';
    if (useful === this.promptVisible) return;
    this.promptVisible = useful;
    this.prompt.style.opacity = useful ? '1' : '0';
    // Re-run the entrance animation each time it comes back, so a player who
    // pressed Escape and forgot gets a fresh, moving cue rather than a static
    // panel they have already learned to ignore.
    if (useful) {
      this.prompt.style.animation = 'none';
      void this.prompt.offsetWidth;
      this.prompt.style.animation = '';
    }
  }
}

/**
 * Consecutive refusals before the game accepts that this browser cannot capture
 * the mouse at all, and hands the aim to the bare cursor.
 *
 * Two, and the number is a compromise between two ways of being unplayable.
 * One refusal is not proof — the commonest single refusal in the wild is an
 * unfocused window, the player's very next click fixes it, and concluding
 * "denied" from it condemns them to flying with an absolute cursor forever.
 * But the fallback is also the only control a genuinely locked-out embedding
 * has, so it cannot be held back for long: at two, the ordinary double-click
 * both gets its chance to capture *and* settles the question if it fails.
 */
const DENY_AFTER = 2;

const PROMPT_SUB = 'style="opacity:.62;font-weight:500;font-size:12.5px;letter-spacing:.02em"';

/** Helper: build the lock prompt HTML, with the title and body translated via i18n. */
function buildPrompt(titleKey: string, bodyKey: string, titleColor: string): string {
  return (
    `<i class="ct-lp-ring"></i>`
    + `<i class="ct-lp-mouse"></i>`
    + `<span><b style="color:${titleColor};font-weight:700">${t(titleKey)}</b>`
    + `<br><span ${PROMPT_SUB}>${t(bodyKey)}</span></span>`
  );
}

/** The normal case: capture is available and the player has not taken it. */
function PROMPT_INVITE(): string {
  return buildPrompt('lockInviteTitle', 'lockInviteBody', '#ffcf6b');
}

/**
 * The browser refused, and the window did not have focus when it did. Keeps the
 * ring: there IS something to click and clicking it will very probably work.
 */
function PROMPT_FOCUS(): string {
  return buildPrompt('lockFocusTitle', 'lockFocusBody', '#ffcf6b');
}

/**
 * The browser has refused pointer lock. No ring — there is nothing to click,
 * and an animated call to action that cannot be satisfied is just a nag.
 */
function PROMPT_DENIED(): string {
  return buildPrompt('lockDeniedTitle', 'lockDeniedBody', '#eef4fb');
}

