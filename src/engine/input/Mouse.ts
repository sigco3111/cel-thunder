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

    target.addEventListener('mousedown', this.onDown);
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
    if (this.wantLock && !this.locked) this.requestLock();
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
      this.dx = 0; this.dy = 0;
      // Coming back out of lock, the OS restores the cursor to wherever it was
      // when we captured it; that stale position must not snap the reticle.
      this.movedUnlocked = false;
    }
    this.syncPrompt();
  };

  private onLockError = (): void => {
    this.locked = false;
    this.syncPrompt();
  };

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

  requestLock(): void {
    const now = performance.now();
    // Chrome throws a SecurityError if you re-request within ~1.25 s of an
    // Escape-triggered exit; do not spam it.
    if (now - this.lastLockAttempt < 400) return;
    this.lastLockAttempt = now;
    try {
      // 'unadjustedMovement' asks the browser for raw, un-accelerated deltas.
      // It is only supported on Chromium; elsewhere the call either ignores the
      // argument or rejects, and we fall back to the plain request.
      const el = this.el;
      const req = (el as unknown as { requestPointerLock?: (o?: unknown) => unknown })?.requestPointerLock;
      if (!el || !req) return;
      const p = req.call(el, { unadjustedMovement: true });
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => {
          // The retry returns a promise of its own in Chromium, and leaving it
          // unhandled surfaces as an "unhandled rejection" in the console —
          // which is indistinguishable from a real fault in any harness that
          // treats console errors as failures. Swallow it here: a denied lock
          // is an expected outcome, not an error.
          try { swallow(req.call(el)); } catch { /* denied */ }
        });
      }
    } catch { /* denied — the prompt stays up and the next click retries */ }
  }

  /** Returns the movement accumulated since the last call and resets it. */
  drain(out: { dx: number; dy: number; wheel: number }): void {
    out.dx = this.dx; out.dy = this.dy; out.wheel = this.wheel;
    this.dx = 0; this.dy = 0; this.wheel = 0;
  }

  // -------------------------------------------------------------------------
  // Prompt overlay
  // -------------------------------------------------------------------------

  private buildPrompt(): void {
    const el = document.createElement('div');
    el.id = 'ct-lock-prompt';
    el.setAttribute('role', 'status');
    // Inline styles: there is no stylesheet to depend on and this must render
    // correctly on the very first frame, before any UI system has initialised.
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:9%', 'transform:translateX(-50%)',
      'z-index:60', 'pointer-events:none', 'opacity:0',
      'transition:opacity .28s ease',
      'font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'letter-spacing:.22em', 'text-transform:uppercase',
      'color:#dfe8f2',
      'padding:11px 20px 10px',
      'background:linear-gradient(180deg,rgba(9,14,22,.82),rgba(9,14,22,.62))',
      'border:1px solid rgba(190,215,240,.28)',
      'border-radius:2px',
      'box-shadow:0 2px 18px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06)',
      'text-shadow:0 1px 2px rgba(0,0,0,.8)',
      'backdrop-filter:blur(3px)',
      'white-space:nowrap',
    ].join(';');
    el.innerHTML =
      '<span style="color:#ffcf6b">Click</span> to take the controls' +
      '<span style="opacity:.45;margin:0 10px">/</span>' +
      '<span style="opacity:.7">Esc releases the mouse</span>';
    document.body.appendChild(el);
    this.prompt = el;
    this.syncPrompt();
  }

  private syncPrompt(): void {
    if (!this.prompt) return;
    const show = this.wantLock && !this.locked && !this.promptSuppressed;
    if (show === this.promptVisible) return;
    this.promptVisible = show;
    this.prompt.style.opacity = show ? '1' : '0';
  }
}

/** Ignores a rejected pointer-lock promise without leaving it unhandled. */
function swallow(p: unknown): void {
  if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
}
