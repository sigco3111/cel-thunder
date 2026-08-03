import { shouldSwallow } from './bindings';

/**
 * Keyboard device.
 *
 * Emits *codes* into a set that the input system unions with the other
 * devices. Three details matter for a game:
 *
 *  - 'keydown' auto-repeat must be ignored: a held key is one press, and
 *    letting the repeat through makes every "on press" action fire at the OS
 *    repeat rate.
 *  - Losing window focus while a key is down leaves it stuck forever, which in
 *    a flight game means the aircraft rolls into the ground while the player is
 *    in another tab. Clearing on blur/visibility is not optional.
 *  - While the chat box has focus the game must see no keys at all, or typing
 *    "gear" retracts the gear.
 */
export class Keyboard {
  readonly codes = new Set<string>();
  /**
   * Keys that went down since the input system last sampled, whether or not
   * they are still down now.
   *
   * The system samples once a frame and derives "pressed" from the difference
   * between two consecutive samples. A tap shorter than a frame — 8 ms on a
   * 120 Hz mouse hand, and routinely that short for gear, flaps and throttle
   * presets — goes down and up between two samples and is simply never seen.
   * Latching it here means a press is never lost no matter how brief; the
   * system unions this into its code set and clears it after each frame, so a
   * one-frame tap still reads as exactly one press.
   */
  readonly tapped = new Set<string>();
  /** True while a text field or contenteditable owns the keyboard. */
  textFocus = false;
  /** Raw printable characters typed since the last drain (chat capture). */
  private typed: string[] = [];

  private bound = false;

  attach(): void {
    if (this.bound) return;
    this.bound = true;
    addEventListener('keydown', this.onKeyDown, { passive: false });
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.clear);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('focusin', this.onFocusChange, true);
    document.addEventListener('focusout', this.onFocusChange, true);
  }

  detach(): void {
    if (!this.bound) return;
    this.bound = false;
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    removeEventListener('blur', this.clear);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('focusin', this.onFocusChange, true);
    document.removeEventListener('focusout', this.onFocusChange, true);
    this.clear();
  }

  private onFocusChange = (): void => {
    const el = document.activeElement as HTMLElement | null;
    const tag = el?.tagName;
    const editable =
      tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable === true;
    if (editable !== this.textFocus) {
      this.textFocus = !!editable;
      if (this.textFocus) { this.codes.clear(); this.tapped.clear(); }
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.textFocus) return;
    if (e.repeat) return;
    this.codes.add(e.code);
    this.tapped.add(e.code);
    if (e.key.length === 1) this.typed.push(e.key);
    // Only swallow keys the browser would otherwise act on (scroll, focus
    // traversal, back-navigation). Everything else stays available so the
    // devtools shortcuts and the OS keep working.
    if (shouldSwallow(e.code) && !e.ctrlKey && !e.metaKey) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.codes.delete(e.code);
  };

  private onVisibility = (): void => { if (document.hidden) this.clear(); };

  clear = (): void => { this.codes.clear(); this.tapped.clear(); };

  /** Called once per sampled frame, after the codes have been read. */
  clearTaps(): void { this.tapped.clear(); }

  drainTyped(): string[] {
    if (this.typed.length === 0) return EMPTY;
    const out = this.typed;
    this.typed = [];
    return out;
  }
}

const EMPTY: string[] = [];
