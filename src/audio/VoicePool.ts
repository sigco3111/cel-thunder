/**
 * Voice budget and stealing.
 *
 * A furball can easily ask for 300 simultaneous sounds — six aircraft firing
 * eight-barrel batteries while three things explode. Playing all of them costs
 * frames and, worse, sounds like mush: every extra correlated voice raises the
 * noise floor and buries the transients that actually carry information.
 *
 * So we cap the count and steal. The scoring rule is deliberately simple and
 * monotonic: a voice's worth is its intrinsic priority scaled by how loud it
 * will actually be at the listener. That makes the nearest cannon beat a distant
 * machine gun without any special-casing, and it makes distant explosions lose
 * to close ones, which is what a listener expects.
 *
 * Stealing always fades over ~10 ms rather than stopping outright. A hard stop
 * on a signal that is not at zero is a step discontinuity — a click — and one
 * click undoes an hour of careful synthesis.
 */

export interface Voice {
  /** Monotonic id, also used as a tiebreaker so equal-score voices are stable. */
  id: number;
  /** 0..1 intrinsic importance (own gunfire > distant engine). */
  priority: number;
  /** Estimated linear loudness at the listener, 0..1. Updated for persistents. */
  loudness: number;
  /** AudioContext time at which this voice frees itself. Infinity = persistent. */
  endsAt: number;
  /** Fade to silence and release resources. 'fade' is in seconds. */
  release(fade: number): void;
  /** Persistent voices (engines, gun loops) are only culled by their owners. */
  persistent: boolean;
}

const STEAL_FADE = 0.012;

export class VoicePool {
  /** Hard cap on concurrent voices. Tuned per quality tier. */
  max = 48;

  /**
   * Master gate. False while the AudioContext is suspended (before the first
   * user gesture): nodes scheduled against a frozen clock would all sit at
   * t = 0 and then fire together in one enormous burst the instant the context
   * resumes. Every one-shot in the game goes through 'request', so refusing
   * here refuses all of them in one place.
   */
  enabled = true;

  private voices: Voice[] = [];
  private nextId = 1;

  get count(): number { return this.voices.length; }

  allocId(): number { return this.nextId++; }

  /**
   * Reserve a slot. Returns false if the pool is full of things more important
   * than the caller, in which case the caller must not create any nodes.
   */
  request(priority: number, loudness: number, now: number): boolean {
    if (!this.enabled) return false;
    this.reap(now);
    if (this.voices.length < this.max) return true;

    const want = priority * (0.25 + 0.75 * loudness);
    let worstIdx = -1;
    let worstScore = Infinity;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.persistent) continue;               // owners cull these, not us
      const s = v.priority * (0.25 + 0.75 * v.loudness);
      if (s < worstScore) { worstScore = s; worstIdx = i; }
    }
    // Only steal if we genuinely beat the weakest voice; otherwise dropping the
    // new sound is the honest answer and avoids thrash under sustained overload.
    if (worstIdx < 0 || worstScore >= want) return false;

    const victim = this.voices[worstIdx];
    this.voices.splice(worstIdx, 1);
    try { victim.release(STEAL_FADE); } catch { /* already gone */ }
    return true;
  }

  add(v: Voice): Voice {
    this.voices.push(v);
    return v;
  }

  remove(v: Voice): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /** Drop voices whose scheduled tail has already finished. */
  reap(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].endsAt <= now) this.voices.splice(i, 1);
    }
  }

  /** Emergency: silence everything (tab hidden, dispose, context lost). */
  releaseAll(fade = 0.05): void {
    const all = this.voices;
    this.voices = [];
    for (const v of all) { try { v.release(fade); } catch { /* ignore */ } }
  }

  /**
   * Shrink the cap (quality dropped). Trims from the weakest end so the change
   * is inaudible rather than a sudden hole in the mix.
   */
  setMax(n: number, now: number): void {
    this.max = Math.max(6, n | 0);
    this.reap(now);
    while (this.voices.length > this.max) {
      let worstIdx = -1, worstScore = Infinity;
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        if (v.persistent) continue;
        const s = v.priority * (0.25 + 0.75 * v.loudness);
        if (s < worstScore) { worstScore = s; worstIdx = i; }
      }
      if (worstIdx < 0) break;
      const victim = this.voices[worstIdx];
      this.voices.splice(worstIdx, 1);
      try { victim.release(0.05); } catch { /* ignore */ }
    }
  }
}
