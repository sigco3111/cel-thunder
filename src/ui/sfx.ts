/**
 * The UI's voice.
 *
 * The audio subsystem already ships every sound a menu needs — 'ui:click',
 * 'ui:hover', 'ui:confirm', 'ui:back', 'ui:error', plus 'hit:marker' and
 * 'kill:confirm' — and until now nothing in src/ui ever asked for one. Every
 * menu, tab, slider, deploy, respawn and hit marker was silent, which reads as
 * an unfinished prototype the instant you click anything.
 *
 * The indirection exists so the widgets do not have to know about the subsystem
 * registry: 'UiSystem.init' installs the sink once, and everything else calls
 * 'sfx(...)'. Before the sink is installed (and in any environment without an
 * audio subsystem) the calls are no-ops rather than errors.
 */

export type UiSoundName =
  | 'ui:click' | 'ui:hover' | 'ui:confirm' | 'ui:back' | 'ui:error'
  | 'hit:marker' | 'kill:confirm';

type Sink = (name: UiSoundName) => void;

let sink: Sink | null = null;

/** Installed by UiSystem once it has resolved the audio subsystem. */
export function setUiAudioSink(fn: Sink | null): void { sink = fn; }

export function sfx(name: UiSoundName): void {
  if (!sink) return;
  try { sink(name); } catch { /* audio must never be able to break the UI */ }
}

/**
 * Hover is emitted from a delegated 'pointerover', which fires again for every
 * child element the pointer crosses inside the same control. Without this the
 * sound machine-guns as the cursor moves across a button's label.
 */
let lastHover: EventTarget | null = null;
export function hoverSfx(control: EventTarget | null): void {
  if (control === lastHover) return;
  lastHover = control;
  if (control) sfx('ui:hover');
}
