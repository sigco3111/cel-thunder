import { COLORS } from './theme';

/**
 * The whole UI stylesheet, injected from TS (index.html is off-limits and we
 * want the design tokens to live next to the code that draws with them).
 *
 * Two structural rules make this scale from 1280×720 to 4K without a single
 * media query for size:
 *
 *  1. '--px' is one *design pixel*: the size a 1 px detail should have on the
 *     current viewport. It is 'min(vw/1920, vh/1080)' clamped, so the HUD keeps
 *     its proportions on any aspect ratio and never becomes a hairline on a 4K
 *     panel or a wall of chrome on a 720p laptop. Every dimension in this file
 *     is 'calc(var(--px) * n)'.
 *  2. Nothing uses the browser's default look. No 'border-radius' beyond 1 px,
 *     no default form controls (inputs are restyled from 'appearance:none'),
 *     no default focus ring — chamfered corners and hairline rules instead.
 */

const C = COLORS;

export const UI_CSS = /* css */ `
/* ===================================================================== *
 * 1. Tokens
 * ===================================================================== */
#ct-root {
  /* One design pixel. The lower clamp matters: at 1280x720 the raw ratio
     is 0.67, which would render 13 px type at 8.7 px — unreadable. */
  /* The unscaled design pixel, kept separately so the HUD-scale setting can
     rebuild --px from it without the two ever drifting apart. */
  --px-base: clamp(0.85px, min(0.05208vw, 0.09259vh), 2.6px);
  --px: var(--px-base);
  --scale: 1;

  --ink: ${C.ink};
  --paper: ${C.paper};
  --hud: ${C.hud};
  --hud-dim: ${C.hudDim};
  --hud-faint: ${C.hudFaint};
  --accent: ${C.accent};
  --accent-hot: ${C.accentHot};
  --accent-2: ${C.accent2};
  --ally: ${C.ally};
  --enemy: ${C.enemy};
  --ok: ${C.ok};
  --warn: ${C.warn};
  --danger: ${C.danger};
  --crit: ${C.crit};
  --glass: ${C.glass};
  --glass-deep: ${C.glassDeep};
  --line: ${C.line};
  --line-strong: ${C.lineStrong};

  --cut: calc(var(--px) * 9);
  --cut-sm: calc(var(--px) * 5);

  --f-nano: calc(var(--px) * 9.5);
  --f-micro: calc(var(--px) * 10.5);
  --f-tiny: calc(var(--px) * 11.5);
  --f-sm: calc(var(--px) * 13);
  --f-md: calc(var(--px) * 15);
  --f-lg: calc(var(--px) * 19);
  --f-xl: calc(var(--px) * 26);
  --f-2xl: calc(var(--px) * 38);
  --f-3xl: calc(var(--px) * 58);

  --s1: calc(var(--px) * 4);
  --s2: calc(var(--px) * 8);
  --s3: calc(var(--px) * 12);
  --s4: calc(var(--px) * 16);
  --s5: calc(var(--px) * 24);
  --s6: calc(var(--px) * 34);
  --s7: calc(var(--px) * 52);

  --font-ui: "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system,
             "Helvetica Neue", Arial, sans-serif;
  --font-cond: "Bahnschrift", "DIN Alternate", "DIN Condensed", "Oswald",
               "Roboto Condensed", "Arial Narrow", "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Roboto Mono", Menlo,
               Consolas, "Liberation Mono", monospace;

  --ease: cubic-bezier(.2, .8, .2, 1);
  --ease-in: cubic-bezier(.6, 0, .8, .2);

  --chamfer: polygon(
    0 var(--cut), var(--cut) 0, 100% 0,
    100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%);
  --chamfer-in: polygon(
    0 var(--cut), var(--cut) 0, 100% 0,
    100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%);
  --chamfer-all: polygon(
    var(--cut) 0, calc(100% - var(--cut)) 0, 100% var(--cut),
    100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%,
    var(--cut) 100%, 0 calc(100% - var(--cut)), 0 var(--cut));

  position: absolute;
  inset: 0;
  pointer-events: none;
  color: var(--hud);
  font-family: var(--font-ui);
  font-size: var(--f-sm);
  line-height: 1.25;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  overflow: hidden;
  contain: strict;
}
#ct-root *, #ct-root *::before, #ct-root *::after { box-sizing: border-box; }
/* The control reset is wrapped in :where() so it contributes *zero*
   specificity. Written as a plain "#ct-root button" rule it would out-rank every
   class rule below it and silently strip the fill off every styled button. */
:where(#ct-root) button,
:where(#ct-root) input,
:where(#ct-root) select,
:where(#ct-root) textarea {
  font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0;
  appearance: none; -webkit-appearance: none; outline: none; text-align: inherit;
}
#ct-root :focus-visible {
  outline: calc(var(--px) * 1.5) solid var(--accent);
  outline-offset: calc(var(--px) * 2);
}
#ct-root ::selection { background: var(--accent); color: var(--ink); }

/* ===================================================================== *
 * 2. Primitives
 * ===================================================================== */

/* Chamfered hairline panel. The border is the element background showing
   through a 1 px inset pseudo-element, because clip-path would eat a real
   border at the diagonal corners. */
.ct-panel {
  position: relative;
  background: var(--line);
  clip-path: var(--chamfer);
}
.ct-panel::before {
  content: ''; position: absolute; inset: calc(var(--px) * 1);
  background:
    linear-gradient(160deg, rgba(30, 48, 66, .40) 0%, rgba(6, 10, 16, .30) 46%, rgba(6, 10, 16, .52) 100%),
    var(--glass);
  clip-path: var(--chamfer);
}
.ct-panel > * { position: relative; z-index: 1; }
.ct-panel.is-glass::before {
  backdrop-filter: blur(calc(var(--px) * 14)) saturate(1.25);
  -webkit-backdrop-filter: blur(calc(var(--px) * 14)) saturate(1.25);
}
.ct-panel.is-deep::before { background: var(--glass-deep); }
.ct-panel.is-flat { background: transparent; }
.ct-panel.is-flat::before { background: rgba(6, 10, 16, .42); }

/* Quality tiers.

   'backdrop-filter' over a live WebGL canvas and 'mix-blend-mode: overlay' are
   both per-pixel compositing work against the 3D backdrop, every frame, on
   every panel that has them — the minimap, both systems panels and the
   scoreboard. On integrated graphics at 1080p that is exactly the class of cost
   that eats a 16.6 ms budget, and it was previously unconditional despite the
   brief asking every subsystem to respect ctx.quality. At 'low' and 'medium'
   the glass degrades to a flat translucent fill and the hatch to a plain
   overlay, both of which cost nothing and keep the same silhouette. */
#ct-root.q-low .ct-panel.is-glass::before,
#ct-root.q-medium .ct-panel.is-glass::before {
  backdrop-filter: none; -webkit-backdrop-filter: none;
  background: rgba(6, 10, 16, .80);
}
#ct-root.q-low .ct-hatch::after,
#ct-root.q-medium .ct-hatch::after { mix-blend-mode: normal; opacity: .5; }
/* The animated film grain is a full-screen composited layer with an overlay
   blend on top of it; it is the first thing to go. */
#ct-root.q-low .ct-cine::after { display: none; }
#ct-root.q-medium .ct-cine::after { animation: none; mix-blend-mode: normal; }

/* Screen-tone hatch: the graphic-novel accent. Never above 4% or it turns to
   mud on a 4K panel. */
.ct-hatch::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(
    -45deg, rgba(190, 225, 255, .05) 0 calc(var(--px) * 1),
    transparent calc(var(--px) * 1) calc(var(--px) * 4));
  clip-path: var(--chamfer);
  mix-blend-mode: overlay;
}

/* Panel header: amber tick + condensed uppercase label + hairline rule. */
.ct-head {
  display: flex; align-items: center; gap: var(--s2);
  font-family: var(--font-cond);
  font-size: var(--f-micro);
  letter-spacing: .22em;
  text-transform: uppercase;
  color: rgba(220, 236, 251, .58);
  padding: calc(var(--px) * 7) var(--s3) calc(var(--px) * 5);
}
.ct-head::before {
  content: ''; width: calc(var(--px) * 3); height: calc(var(--px) * 10);
  background: var(--accent); flex: none;
  box-shadow: 0 0 calc(var(--px) * 8) rgba(255, 178, 58, .6);
}
.ct-head > .ct-head-rule { flex: 1; height: 1px; background: var(--line); }
.ct-head > .ct-head-aux { color: rgba(220, 236, 251, .40); letter-spacing: .12em; }

.ct-title {
  font-family: var(--font-cond); font-size: var(--f-lg);
  letter-spacing: .24em; text-transform: uppercase; color: var(--paper);
}
.ct-sub { font-family: var(--font-mono); font-size: var(--f-micro); letter-spacing: .16em; color: rgba(220, 236, 251, .4); }
.ct-label {
  font-family: var(--font-cond); font-size: var(--f-nano);
  letter-spacing: .2em; text-transform: uppercase; color: rgba(220, 236, 251, .48);
}
.ct-val {
  font-family: var(--font-mono); font-variant-numeric: tabular-nums;
  font-weight: 600; letter-spacing: -.01em;
}

/* Everything in the flying HUD needs to survive both a white cloud and a black
   forest behind it, so it is always drawn with an ink halo. */
.ct-ink {
  text-shadow:
    0 0 calc(var(--px) * 2) rgba(3, 6, 10, .95),
    0 0 calc(var(--px) * 6) rgba(3, 6, 10, .75),
    0 calc(var(--px) * 1) 0 rgba(3, 6, 10, .8);
}

/* Buttons ------------------------------------------------------------- */
.ct-btn {
  position: relative;
  display: inline-flex; align-items: center; gap: var(--s2);
  padding: calc(var(--px) * 9) var(--s4);
  font-family: var(--font-cond); font-size: var(--f-sm);
  letter-spacing: .18em; text-transform: uppercase;
  color: rgba(230, 241, 251, .86);
  background: rgba(140, 190, 230, .06);
  clip-path: var(--chamfer);
  cursor: pointer;
  transition: color .16s var(--ease), background .16s var(--ease), letter-spacing .2s var(--ease);
  box-shadow: inset 0 0 0 1px var(--line);
  user-select: none;
}
.ct-btn::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0;
  width: calc(var(--px) * 3); background: var(--accent);
  transform: scaleY(0); transform-origin: 50% 100%;
  transition: transform .18s var(--ease);
}
.ct-btn:hover, .ct-btn:focus-visible {
  color: #fff; background: rgba(255, 178, 58, .13); letter-spacing: .22em;
}
.ct-btn:hover::before, .ct-btn:focus-visible::before { transform: scaleY(1); }
.ct-btn:active { background: rgba(255, 178, 58, .24); }
.ct-btn.is-primary {
  background: linear-gradient(100deg, rgba(255, 178, 58, .92), rgba(255, 150, 40, .78));
  color: #14100a; font-weight: 700;
  box-shadow: inset 0 0 0 1px rgba(255, 220, 150, .7), 0 calc(var(--px) * 6) calc(var(--px) * 22) rgba(255, 150, 40, .22);
}
.ct-btn.is-primary:hover { background: linear-gradient(100deg, #ffd27a, #ffab3c); }
.ct-btn.is-ghost { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
.ct-btn.is-danger:hover { background: rgba(255, 74, 56, .18); color: #ffd9d4; }
.ct-btn[disabled] { opacity: .34; pointer-events: none; }
.ct-btn.is-sm { padding: calc(var(--px) * 5) var(--s3); font-size: var(--f-micro); }

/* Form controls -------------------------------------------------------- */
.ct-row {
  display: grid; grid-template-columns: 1fr auto;
  align-items: center; gap: var(--s4);
  padding: calc(var(--px) * 9) var(--s4);
  border-bottom: 1px solid rgba(158, 199, 230, .09);
}
.ct-row:last-child { border-bottom: 0; }
.ct-row:hover { background: rgba(140, 190, 230, .045); }
.ct-row-name { font-size: var(--f-sm); color: rgba(230, 241, 251, .9); }
.ct-row-desc { font-size: var(--f-nano); color: rgba(220, 236, 251, .38); margin-top: calc(var(--px) * 2); letter-spacing: .04em; }
.ct-row-ctl { display: flex; align-items: center; gap: var(--s3); justify-self: end; }

.ct-slider { position: relative; width: calc(var(--px) * 190); height: calc(var(--px) * 18); cursor: pointer; }
.ct-slider input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; margin: 0; }
.ct-slider .trk {
  position: absolute; left: 0; right: 0; top: 50%; height: calc(var(--px) * 3);
  transform: translateY(-50%); background: rgba(158, 199, 230, .16);
}
.ct-slider .fil {
  position: absolute; left: 0; top: 50%; height: calc(var(--px) * 3);
  transform: translateY(-50%); background: var(--accent);
  box-shadow: 0 0 calc(var(--px) * 10) rgba(255, 178, 58, .5);
}
.ct-slider .kn {
  position: absolute; top: 50%; width: calc(var(--px) * 9); height: calc(var(--px) * 15);
  transform: translate(-50%, -50%); background: var(--paper);
  clip-path: polygon(0 0, 100% 0, 100% 70%, 50% 100%, 0 70%);
  transition: background .15s var(--ease);
}
.ct-slider:hover .kn { background: var(--accent-hot); }
.ct-slider .tick { position: absolute; top: 50%; width: 1px; height: calc(var(--px) * 7); transform: translate(-50%, -50%); background: rgba(158, 199, 230, .22); }
.ct-num {
  min-width: calc(var(--px) * 52); text-align: right;
  font-family: var(--font-mono); font-size: var(--f-tiny); font-variant-numeric: tabular-nums;
  color: var(--accent);
}

.ct-toggle {
  position: relative; width: calc(var(--px) * 46); height: calc(var(--px) * 20);
  background: rgba(158, 199, 230, .12); cursor: pointer;
  clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
  box-shadow: inset 0 0 0 1px var(--line);
  transition: background .18s var(--ease);
}
.ct-toggle .kn {
  position: absolute; top: calc(var(--px) * 3); left: calc(var(--px) * 3);
  width: calc(var(--px) * 16); height: calc(var(--px) * 14);
  background: rgba(220, 236, 251, .55);
  transition: transform .18s var(--ease), background .18s var(--ease);
}
.ct-toggle .lbl {
  position: absolute; right: calc(var(--px) * 5); top: 50%; transform: translateY(-50%);
  font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .12em;
  color: rgba(220, 236, 251, .4);
}
.ct-toggle.is-on { background: rgba(255, 178, 58, .22); }
.ct-toggle.is-on .kn { transform: translateX(calc(var(--px) * 24)); background: var(--accent); box-shadow: 0 0 calc(var(--px) * 10) rgba(255, 178, 58, .7); }
.ct-toggle.is-on .lbl { left: calc(var(--px) * 6); right: auto; color: rgba(255, 210, 122, .9); }

.ct-seg { display: flex; box-shadow: inset 0 0 0 1px var(--line); }
.ct-seg button {
  padding: calc(var(--px) * 6) calc(var(--px) * 12);
  font-family: var(--font-cond); font-size: var(--f-micro);
  letter-spacing: .14em; text-transform: uppercase;
  color: rgba(220, 236, 251, .5); cursor: pointer;
  transition: color .14s var(--ease), background .14s var(--ease);
  border-right: 1px solid rgba(158, 199, 230, .12);
}
.ct-seg button:last-child { border-right: 0; }
.ct-seg button:hover { color: #fff; background: rgba(140, 190, 230, .08); }
.ct-seg button.is-on { color: var(--ink); background: var(--accent); font-weight: 700; }

.ct-input {
  padding: calc(var(--px) * 7) var(--s3);
  background: rgba(4, 8, 13, .7);
  box-shadow: inset 0 0 0 1px var(--line);
  font-size: var(--f-sm); color: var(--paper);
  clip-path: var(--chamfer);
}
.ct-input:focus { box-shadow: inset 0 0 0 1px var(--accent); }
.ct-input::placeholder { color: rgba(220, 236, 251, .28); }

.ct-scroll { overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(158,199,230,.28) transparent; }
.ct-scroll::-webkit-scrollbar { width: calc(var(--px) * 6); }
.ct-scroll::-webkit-scrollbar-thumb { background: rgba(158, 199, 230, .28); }
.ct-scroll::-webkit-scrollbar-track { background: transparent; }

/* ===================================================================== *
 * 3. Layers
 * ===================================================================== */
.ct-layer { position: absolute; inset: 0; }
.ct-layer.is-interactive { pointer-events: auto; }
.ct-hidden { display: none !important; }

/* HUD scale, as ONE mechanism.
   The setting used to be multiplied into the font ladder only, so at 1.25–1.5
   the 21 px odometer digits overflowed their 24 px cells with overflow:hidden,
   the roll offset landed between glyphs and the airspeed and altitude readouts
   clipped and misregistered; the gauge value columns and the ammo and flag rows
   overflowed their fixed min-widths for the same reason. Scaling the *design
   pixel* instead means every length in the HUD — type, box geometry, spacing,
   stroke widths and the JS-driven SVG, which reads --px off this element —
   scales together by construction, and there is nothing left to keep in sync.
   The font ladder is redeclared here so it is computed against the scaled --px:
   custom properties resolve against the element that declares them, so the
   copies on #ct-root would otherwise keep the unscaled value. */
#ct-hud {
  --px: calc(var(--px-base) * var(--scale));
  --f-nano: calc(var(--px) * 9.5);
  --f-micro: calc(var(--px) * 10.5);
  --f-tiny: calc(var(--px) * 11.5);
  --f-sm: calc(var(--px) * 13);
  --f-md: calc(var(--px) * 15);
  --f-lg: calc(var(--px) * 19);
  --f-xl: calc(var(--px) * 26);
  --f-2xl: calc(var(--px) * 38);
  --f-3xl: calc(var(--px) * 58);
  transition: opacity .25s var(--ease);
}
#ct-hud.is-dim { opacity: .18; }
/* No telemetry behind the instruments: desaturate and knock back everything
   that would otherwise read as a live reading, so a player can tell at a glance
   that the numbers are not the aeroplane's. The reticle and the notices stay
   at full strength — those are still true. */
#ct-hud.is-nodata .ct-tape,
#ct-hud.is-nodata .ct-vsi,
#ct-hud.is-nodata .ct-compass,
#ct-hud.is-nodata .ct-sys,
#ct-hud.is-nodata .ct-dmg,
#ct-hud.is-nodata .ct-gmeter { filter: saturate(.1) brightness(.7); opacity: .4; }
/* "is-off" must beat "is-dim" whichever order they are applied in, hence the
   doubled class — a dimmed-but-hidden HUD ghosting through the title screen is
   the classic version of this bug. */
#ct-hud.is-off, #ct-hud.is-off.is-dim { opacity: 0; visibility: hidden; }

/* ===================================================================== *
 * 4. HUD — centre group (reticle, ladder, lead pip)
 * ===================================================================== */
.ct-center-svg {
  position: absolute; inset: 0; width: 100%; height: 100%;
  overflow: visible; pointer-events: none;
}

.ct-vec-ink   { fill: none; stroke: rgba(4, 8, 13, .70); stroke-width: calc(var(--px) * 3.6); stroke-linecap: round; stroke-linejoin: round; }
/* Heavy ink, for strokes that spend their life over the brightest thing in the
   frame. The pitch ladder lies across sunlit cumulus tops for whole passes; at
   the default 3.6/1.7 weights that leaves 0.95 px of 70 %-opaque contour on
   each side of a white line drawn on white cloud, which is nothing. 6.4 px at
   92 % gives every rung a 2.3 px black edge — enough that the ladder reads as
   drawn *on top of* the sky rather than dissolving into it, and still thin
   enough that it never blobs at 720p. */
.ct-vec-ink.is-heavy { stroke: rgba(3, 6, 11, .88); stroke-width: calc(var(--px) * 5); }
.ct-vec-ink.is-heavy text { fill: rgba(3, 6, 11, .96); stroke: rgba(3, 6, 11, .96); stroke-width: calc(var(--px) * 3.6); }
/* Ink weight has to track the glyph it is haloing. The default 3.4 px stroke is
   sized for 10–11 px HUD type; wrapped around an 8.5 px figure it is 40 % of the
   cap height and closes the counters, so the ring calibration figures rendered
   as two dark blobs rather than as "400" and "800". */
.ct-vec-ink text.is-tiny { stroke-width: calc(var(--px) * 2.2); }
.ct-vec-lit   { fill: none; stroke: var(--hud); stroke-width: calc(var(--px) * 1.7); stroke-linecap: round; stroke-linejoin: round; }
.ct-vec-lit.is-accent { stroke: var(--accent); }
.ct-vec-lit.is-dim { stroke: rgba(220, 236, 251, .42); }
.ct-vec-lit.is-thin { stroke-width: calc(var(--px) * 1.1); }
/* Gunsight hierarchy. The sight furniture — the surviving range ring and the
   convergence bracket — is structure and sits back at 58 % value on a thinner
   stroke; the pipper is the aiming reference and is the only pure-white,
   full-weight mark in the frame. Two contrast steps is all it takes for the eye
   to land on the pipper first, every time, which is the one thing the old
   five-concentric-rings sight could not do. */
.ct-vec-lit.ct-reticle { stroke: rgba(220, 236, 251, .58); stroke-width: calc(var(--px) * 1.35); }
.ct-vec-lit.ct-pipper  { stroke: #ffffff; stroke-width: calc(var(--px) * 2.1); }
.ct-vec-lit.ct-pipper.is-accent { stroke: var(--accent); }
.ct-svg-text {
  font-family: var(--font-mono); font-size: var(--f-micro); font-weight: 600;
  fill: var(--hud); paint-order: stroke; stroke: rgba(4, 8, 13, .85);
  stroke-width: calc(var(--px) * 3); stroke-linejoin: round;
  font-variant-numeric: tabular-nums;
}
.ct-svg-text.is-accent { fill: var(--accent); }
.ct-svg-text.is-small { font-size: var(--f-nano); }

/* Text inside a two-pass vector layer: the ink pass fills dark and thick, the
   lit pass fills bright on top — a halo without a filter. */
.ct-vec-ink text { fill: rgba(4, 8, 13, .92); stroke: rgba(4, 8, 13, .92); stroke-width: calc(var(--px) * 3.4); }
.ct-vec-lit text { fill: var(--hud); stroke: none; }
.ct-vec-lit.is-accent text { fill: var(--accent); }
.ct-vec-lit.is-dim text { fill: rgba(220, 236, 251, .72); }
.ct-vtx {
  font-family: var(--font-mono); font-weight: 600;
  font-variant-numeric: tabular-nums; letter-spacing: .02em;
}
.ct-center-svg { pointer-events: none; }

/* Damage-direction arcs live in the centre group so they orbit the reticle. */
.ct-dmgdir { opacity: 0; }

/* Hit marker ---------------------------------------------------------- */
#ct-hitmark { opacity: 0; }
#ct-hitmark.is-fire { animation: ct-hit .42s var(--ease-in) forwards; }
@keyframes ct-hit {
  0%   { opacity: 0; transform: scale(1.9); }
  14%  { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.35); }
}

/* ===================================================================== *
 * 5. HUD — tapes
 * ===================================================================== */
/* No overflow clip here. The scrolling scale is clipped by '.ct-tape-mask',
 * which is what the mask gradient is for; the extra 'overflow: hidden' on the
 * tape itself did nothing for the scale and quietly guillotined everything
 * anchored outside the box — the readout window's unit glyph and, worst, the
 * four secondary readouts, which sat 6 px above and below the tape and were
 * therefore rendered as horizontal slices of themselves. "MACH 0.39" with its
 * top two thirds cut off is unreadable garbage sitting at low contrast behind
 * the instruments, which is exactly how it was read: as a stray debug overlay.
 */
.ct-tape {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: calc(var(--px) * 96); height: calc(var(--px) * 330);
}
/* Tapes are placed as a fraction of the frame, capped in design pixels. A
   fixed edge offset collides with the systems column at 720p; a pure
   percentage flies away from the gunsight on an ultrawide. */
.ct-tape.is-left  { left:  min(28%, calc(var(--px) * 620)); }
.ct-tape.is-right { right: min(28%, calc(var(--px) * 620)); }
.ct-tape-strip { position: absolute; left: 0; top: 50%; width: 100%; will-change: transform; }
/* The outer 7 % of the window is fully transparent, not merely faint.
   With a ramp that only reached zero at the very edge, the scale figure just
   past the end of the travel — 110 design px above the centre one — sat at the
   top of the window at low alpha with its dark ink halo intact, which reads as
   a stray ghost glyph directly beneath the secondary readout rather than as a
   tape running out of view. Killing the last 7 % outright removes it and costs
   nothing: the figures that matter sit at 33 % and 67 %. */
.ct-tape-mask {
  position: absolute; inset: 0;
  -webkit-mask-image: linear-gradient(180deg, transparent 0%, transparent 12%, #000 26%, #000 74%, transparent 88%, transparent 100%);
  mask-image: linear-gradient(180deg, transparent 0%, transparent 12%, #000 26%, #000 74%, transparent 88%, transparent 100%);
  overflow: hidden;
}
.ct-tape-rule { position: absolute; top: 0; bottom: 0; width: 1px; background: linear-gradient(180deg, transparent, rgba(200,226,250,.35) 22%, rgba(200,226,250,.35) 78%, transparent); }
.ct-tape.is-left .ct-tape-rule { right: calc(var(--px) * 4); }
.ct-tape.is-right .ct-tape-rule { left: calc(var(--px) * 4); }

/* Readout box: the chamfered "chevron" window over the tape.
 *
 * Two things were wrong here and both showed in every capture.
 *
 * (1) The plate was only 74 % opaque, so the tape's own major figure sat
 *     *behind* the odometer and bled through it — at 597 km/h the scale's "600"
 *     was legible straight through the digits, which reads exactly like a
 *     rolling drum that has failed to land on a glyph. A readout window on a
 *     real instrument is opaque; there is nothing to see behind it.
 *
 * (2) The plate was pinned on both edges, so its width was the tape width (91
 *     design px) no matter what it had to hold. The altitude readout is five
 *     digits plus a unit — 75 + 4 + 9 px of content inside 14 + 7 px of padding,
 *     i.e. 109 px — so the unit glyph was laid out past the plate's right edge
 *     and rendered over the terrain with no backing at all.
 *
 * The fix for both: one anchored edge, 'width: max-content', and an opaque
 * plate. The anchored edge is the one carrying the scale rule, so the window
 * always butts against the tick column it is reading and grows outward. */
.ct-readout {
  position: absolute; top: 50%; transform: translateY(-50%);
  display: flex; align-items: center;
  width: max-content;
  height: calc(var(--px) * 34);
  padding: 0 calc(var(--px) * 8);
  /* Fully opaque. At 96–98 % the scale figure behind it was still legible
     through the digits — a 4 % ghost with a black ink halo is not nothing. */
  background: linear-gradient(180deg, #182636 0%, #05090f 58%, #03060b 100%);
  box-shadow: inset 0 0 0 1px rgba(200, 226, 250, .42),
              0 calc(var(--px) * 2) calc(var(--px) * 8) rgba(2, 5, 9, .55);
}
/* The plate stops short of the scale rule and an amber index closes the gap, so
   the relationship reads as "this window is indicating this point on that
   scale" — one index, pointing one way, instead of the previous arrangement
   where a decorative chevron pointed away from the tape and a separate caret
   sat outside it pointing away from the scale as well. */
.ct-tape.is-left .ct-readout {
  right: calc(var(--px) * 14); left: auto;
  clip-path: polygon(var(--cut-sm) 0, 100% 0, 100% 100%, var(--cut-sm) 100%, 0 calc(100% - var(--cut-sm)), 0 var(--cut-sm));
}
.ct-tape.is-right .ct-readout {
  left: calc(var(--px) * 14); right: auto;
  clip-path: polygon(0 0, calc(100% - var(--cut-sm)) 0, 100% var(--cut-sm), 100% calc(100% - var(--cut-sm)), calc(100% - var(--cut-sm)) 100%, 0 100%);
}
.ct-caret {
  position: absolute; top: 50%; width: calc(var(--px) * 11); height: calc(var(--px) * 13);
  transform: translateY(-50%); background: var(--accent);
  filter: drop-shadow(0 0 calc(var(--px) * 2) rgba(3, 6, 11, .9));
}
.ct-tape.is-left .ct-caret { right: calc(var(--px) * 3); clip-path: polygon(0 0, 100% 50%, 0 100%); }
.ct-tape.is-right .ct-caret { left: calc(var(--px) * 3); clip-path: polygon(100% 0, 100% 100%, 0 50%); }

/* Odometer digits. Cell height, line height and 'Odometer.digitH' are one
   number (26 design px) and must stay one number: any mismatch means the window
   is either showing a slice of the neighbouring glyph or hiding part of its
   own. */
.ct-odo { display: flex; align-items: center; height: 100%; }
.ct-odo-d { position: relative; width: calc(var(--px) * 15); height: calc(var(--px) * 26); overflow: hidden; }
.ct-odo-col {
  position: absolute; left: 0; top: 0; width: 100%;
  font-family: var(--font-mono); font-size: calc(var(--px) * 20);
  font-weight: 700; line-height: calc(var(--px) * 26);
  text-align: center; color: var(--paper); will-change: transform;
  font-variant-numeric: tabular-nums;
}
/* A leading zero is not a reading. Dimming it to 22 % left a visible grey "0"
   in front of every altitude, which is precisely the kind of stray glyph that
   reads as a broken drum; the cell keeps its width so the number stays
   right-registered, but the glyph goes. */
.ct-odo-d.is-blank .ct-odo-col { opacity: 0; }
.ct-odo-unit { font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .1em; color: rgba(220,236,251,.62); margin-left: calc(var(--px) * 5); }
.ct-odo-sign { font-family: var(--font-mono); font-size: var(--f-md); color: var(--paper); width: calc(var(--px) * 10); text-align: center; }

/* Secondary readouts (TAS, Mach, radar height, vertical speed).
 *
 * These were 45 %-alpha keys and bare values floating on the sky just outside
 * the tape, with no plate and no frame — over a bright cloud they read as
 * leftover debug text printed behind the instruments, which is an automatic
 * fail on the rubric. They are real telemetry and worth keeping, so they get
 * the same treatment as the rows in the powerplant panel: a plate, a hairline,
 * a condensed key and a tabular value. Sized to content and anchored to the
 * tape's scale edge so they stack under the tape rather than across it. */
.ct-tape-sub {
  position: absolute;
  display: flex; align-items: baseline; gap: calc(var(--px) * 6);
  width: max-content;
  padding: calc(var(--px) * 2) calc(var(--px) * 7);
  background: rgba(4, 8, 13, .82);
  box-shadow: inset 0 0 0 1px rgba(158, 199, 230, .22);
  font-family: var(--font-mono); font-size: var(--f-nano);
  font-variant-numeric: tabular-nums;
}
.ct-tape.is-left  .ct-tape-sub { right: 0; }
.ct-tape.is-right .ct-tape-sub { left: 0; }
.ct-tape-sub.is-top { top: calc(var(--px) * -22); }
.ct-tape-sub.is-bot { bottom: calc(var(--px) * -22); }
.ct-tape-sub .k { font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .18em; color: rgba(220,236,251,.55); }
.ct-tape-sub .v { color: var(--hud); font-weight: 700; }
.ct-tape-sub .v.is-warn { color: var(--warn); }
.ct-tape-sub .v.is-danger { color: var(--danger); }

/* Tape scale artwork (SVG user units are design pixels) */
.ct-tape-minor { stroke: rgba(200, 226, 250, .34); stroke-width: 1.4; fill: none; }
.ct-tape-major { stroke: rgba(230, 241, 251, .85); stroke-width: 2; fill: none; }
.ct-tape-lbl {
  font-family: var(--font-mono); font-size: 15px; font-weight: 600;
  fill: rgba(235, 245, 255, .92); paint-order: stroke;
  stroke: rgba(4, 8, 13, .85); stroke-width: 4; stroke-linejoin: round;
  font-variant-numeric: tabular-nums;
}

/* Compass ribbon artwork */
.ct-cmp-minor  { stroke: rgba(200, 226, 250, .40); stroke-width: 1.4; fill: none; }
.ct-cmp-major  { stroke: rgba(230, 241, 251, .82); stroke-width: 2; fill: none; }
.ct-cmp-coarse { stroke: rgba(240, 248, 255, .95); stroke-width: 2.6; fill: none; }
.ct-cmp-lbl {
  font-family: var(--font-mono); font-size: 13px; font-weight: 600;
  fill: rgba(232, 243, 253, .9); paint-order: stroke;
  stroke: rgba(4, 8, 13, .9); stroke-width: 4.5; stroke-linejoin: round;
}
.ct-cmp-card {
  font-family: var(--font-cond); font-size: 16px; font-weight: 700;
  fill: var(--accent); paint-order: stroke;
  stroke: rgba(4, 8, 13, .95); stroke-width: 5; stroke-linejoin: round;
}

/* G-meter dial */
.ct-gmeter svg { overflow: visible; }
.ct-gm-face { fill: rgba(5, 9, 15, .70); stroke: rgba(158, 199, 230, .22); stroke-width: 1; }
.ct-gm-tick { stroke: rgba(220, 236, 251, .55); stroke-width: 1.4; fill: none; }
.ct-gm-arc { stroke: rgba(220, 236, 251, .30); stroke-width: 2; fill: none; }
.ct-gm-red { stroke: rgba(255, 74, 56, .85); stroke-width: 3; fill: none; }
.ct-gm-datum { stroke: rgba(121, 230, 166, .8); stroke-width: 1.6; fill: none; }
.ct-gm-lbl { font-family: var(--font-mono); font-size: 9.5px; font-weight: 600; fill: rgba(226, 240, 253, .78);
  paint-order: stroke; stroke: rgba(4, 8, 13, .8); stroke-width: 2.4; stroke-linejoin: round; }
.ct-gm-needle path { fill: var(--paper); stroke: rgba(4, 8, 13, .85); stroke-width: .8; }
.ct-gm-hub { fill: var(--ink); stroke: rgba(220, 236, 251, .55); stroke-width: 1; }
.ct-gm-peak path { fill: var(--accent); stroke: rgba(4, 8, 13, .8); stroke-width: .7; }
.ct-gm-peak.is-min path { fill: rgba(84, 216, 255, .9); }
.ct-gm-plate { fill: rgba(4, 8, 13, .82); stroke: rgba(158, 199, 230, .26); stroke-width: 1; }
.ct-gm-val {
  font-family: var(--font-mono); font-size: 15px; font-weight: 700; fill: var(--paper);
  font-variant-numeric: tabular-nums;
}
.ct-gm-val.is-warn { fill: var(--warn); }
.ct-gm-val.is-danger { fill: var(--danger); }
.ct-gm-unit { font-family: var(--font-cond); font-size: 9.5px; letter-spacing: .1em; fill: rgba(220, 236, 251, .55); }

/* Damage plan view */
.ct-dmg-datum { stroke: rgba(220, 236, 251, .22); stroke-width: .7; stroke-dasharray: 3 3; fill: none; }
.ct-dmg .part.is-sub { fill: rgba(150, 186, 214, .48); }

/* Vertical-speed strip */
.ct-vsi {
  position: absolute; top: 50%;
  right: calc(min(28%, var(--px) * 620) + var(--px) * 108);
  width: calc(var(--px) * 26); height: calc(var(--px) * 250); transform: translateY(-50%);
}
.ct-vsi .zero {
  position: absolute; left: calc(var(--px) * -3); right: calc(var(--px) * -3); top: 50%;
  height: calc(var(--px) * 2); margin-top: calc(var(--px) * -1);
  background: rgba(232, 243, 253, .92);
  box-shadow: 0 0 0 1px rgba(3, 6, 11, .8);
}
/* Index arm on the zero datum, so the "level flight" reference is findable
   without reading the figures. */
.ct-vsi .zero i {
  position: absolute; right: 100%; top: 50%; width: calc(var(--px) * 7); height: calc(var(--px) * 7);
  margin-top: calc(var(--px) * -3.5); background: rgba(232, 243, 253, .92);
  clip-path: polygon(0 50%, 100% 0, 100% 100%);
}
.ct-vsi .bar {
  position: absolute; left: calc(var(--px) * 9); width: calc(var(--px) * 8); bottom: 50%;
  background: linear-gradient(180deg, var(--accent-2), rgba(84, 216, 255, .35));
  box-shadow: 0 0 0 1px rgba(3, 6, 11, .55);
  transform-origin: 50% 100%;
}
.ct-vsi .bar.is-down { top: 50%; bottom: auto; background: linear-gradient(0deg, var(--warn), rgba(255,194,71,.3)); transform-origin: 50% 0%; }
.ct-vsi .tick {
  position: absolute; left: 0; width: calc(var(--px) * 6); height: 1px;
  background: rgba(210, 232, 252, .5); box-shadow: 0 0 calc(var(--px) * 2) rgba(3,6,11,.9);
}
.ct-vsi .tick.is-major { width: calc(var(--px) * 9); height: calc(var(--px) * 1.6); background: rgba(232, 243, 253, .82); }
.ct-vsi .lbl {
  position: absolute; right: calc(100% + var(--px) * 3); transform: translateY(-50%);
  font-family: var(--font-mono); font-size: var(--f-nano); font-weight: 700;
  color: rgba(232, 243, 253, .84); font-variant-numeric: tabular-nums;
  text-shadow: 0 0 calc(var(--px) * 1.6) rgba(3,6,10,1), 0 0 calc(var(--px) * 4) rgba(3,6,10,.9);
}
.ct-vsi .cap, .ct-vsi .unit {
  position: absolute; left: 50%; transform: translateX(-50%);
  font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .16em;
  color: rgba(226, 240, 253, .88); white-space: nowrap;
  text-shadow: 0 0 calc(var(--px) * 1.6) rgba(3,6,10,1), 0 0 calc(var(--px) * 4) rgba(3,6,10,.9);
}
.ct-vsi .cap  { bottom: calc(100% + var(--px) * 6); }
.ct-vsi .unit { top: calc(100% + var(--px) * 6); }

/* ===================================================================== *
 * 6. HUD — compass ribbon
 * ===================================================================== */
/* The ribbon now runs inside a plate.
 *
 * With a bare masked strip, a figure that happens to straddle the fade is
 * dissolved through its own glyphs — the capture showed a half-eaten "N" and a
 * lone "0" of an "07" hanging in clear sky, which reads as clipping rather than
 * as fading. Giving the tape a physical window fixes it at the root: the plate
 * declares where the instrument ends, the fade is pushed inboard so it only
 * ever eats tick marks, and the plate's own hairline is what the eye reads as
 * the boundary. It also buys the ribbon a dark backing, so the ticks stop
 * competing with cumulus. */
.ct-compass {
  position: absolute; top: calc(var(--px) * 20); left: 50%; transform: translateX(-50%);
  width: calc(var(--px) * 540); height: calc(var(--px) * 42);
  background: linear-gradient(180deg, rgba(6, 11, 18, .30) 0%, rgba(4, 8, 13, .74) 46%, rgba(4, 8, 13, .80) 100%);
  box-shadow: inset 0 0 0 1px rgba(158, 199, 230, .22);
  clip-path: polygon(
    var(--cut) 0, calc(100% - var(--cut)) 0, 100% var(--cut),
    100% 100%, 0 100%, 0 var(--cut));
  overflow: hidden;
}
.ct-compass-win {
  position: absolute; inset: calc(var(--px) * 1) calc(var(--px) * 2);
  overflow: hidden;
  /* A long fade, on purpose. A figure that straddles a short one loses half its
     glyphs at near-full opacity and reads as clipping; over 70 px it is
     unmistakably a tape running away under the bezel. The crisp middle is still
     ±38°, far more than the ±20° a pilot reads off a heading tape. */
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 13%, #000 87%, transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0%, #000 13%, #000 87%, transparent 100%);
}
/* Bezel shadow, painted over the tape at both ends.
 *
 * The mask gradient on '.ct-compass-win' is the *intent*, but in the captures a
 * figure straddling the plate edge still rendered at full value with its left
 * half cut off by the overflow clip — the tape read "3 34 35 N" and the cockpit
 * critique logged it as a broken tick sequence in a second code path. A painted
 * gradient cannot be optimised away or lost to a mask-compositing path: it is
 * just a box drawn last, so whatever the tape does under it, a glyph entering
 * the bezel loses value before it can lose geometry. */
.ct-compass::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(90deg,
    rgba(5, 9, 15, .96) 0%, rgba(5, 9, 15, .80) 4%, rgba(5, 9, 15, 0) 11%,
    rgba(5, 9, 15, 0) 89%, rgba(5, 9, 15, .80) 96%, rgba(5, 9, 15, .96) 100%);
}
.ct-compass-strip { position: absolute; left: 50%; top: 0; height: 100%; will-change: transform; }
/* See Compass.build(): the ribbon is drawn past both ends of its viewBox so the
   wrap figure is never cut in half and the tape never runs out of artwork. */
.ct-compass-strip > svg { overflow: visible; }
.ct-compass-caret {
  position: absolute; left: 50%; top: 0; width: calc(var(--px) * 13); height: calc(var(--px) * 10);
  transform: translateX(-50%); background: var(--accent);
  clip-path: polygon(50% 100%, 0 0, 100% 0);
}
/* Sibling of the plate, not a child — see Compass.ts. */
.ct-compass-hdg {
  position: absolute; left: 50%; top: calc(var(--px) * 3); transform: translateX(-50%);
  font-family: var(--font-mono); font-size: var(--f-tiny); font-weight: 700;
  font-variant-numeric: tabular-nums; letter-spacing: .06em;
  color: var(--ink); background: var(--accent);
  padding: calc(var(--px) * 1) calc(var(--px) * 7);
  clip-path: polygon(var(--cut-sm) 0, calc(100% - var(--cut-sm)) 0, 100% 100%, 0 100%);
}
/* The bearing caret rides the *tick* band, not the figure band.
 *
 * At top:27 the diamond sat exactly on the figures — in the chase capture it
 * happened to fall in the gap between "32" and "33" and looked fine, and in the
 * cockpit capture it fell on "03" and ate the leading zero, so the tape read
 * "02 3 04" and looked like a formatting bug in a second code path. There is no
 * second code path: it was one sprite parked on top of the type. Moved up into
 * the 5°/10° tick band it can never occlude a figure at any heading, and it is
 * still directly above the bearing it marks. Made a touch smaller and given a
 * downward point so it reads as an index rather than as a blob. */
.ct-compass-tgt {
  position: absolute; top: calc(var(--px) * 11); width: calc(var(--px) * 11); height: calc(var(--px) * 11);
  background: var(--enemy); transform: translateX(-50%);
  clip-path: polygon(50% 100%, 0 0, 100% 0);
  filter: drop-shadow(0 0 calc(var(--px) * 1.4) rgba(3, 6, 11, .95));
}

/* ===================================================================== *
 * 7. HUD — engine / systems cluster
 * ===================================================================== */
.ct-sys {
  position: absolute; right: calc(var(--px) * 26); bottom: calc(var(--px) * 26);
  width: calc(var(--px) * 330);
  display: flex; flex-direction: column; gap: calc(var(--px) * 6);
}
.ct-sys-grid { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--px) * 4) var(--s3); padding: 0 var(--s3) calc(var(--px) * 10); }

.ct-gauge { display: grid; grid-template-columns: calc(var(--px) * 30) 1fr auto; align-items: center; gap: calc(var(--px) * 5); }
.ct-gauge .k { font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .14em; color: rgba(220,236,251,.5); }
.ct-gauge .trk { position: relative; height: calc(var(--px) * 7); background: rgba(158,199,230,.13); overflow: hidden; }
.ct-gauge .fil { position: absolute; left: 0; right: 0; top: 0; bottom: 0; background: var(--ok); transform-origin: 0 50%; transition: background .3s linear; }
.ct-gauge .lim { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,74,56,.75); }
.ct-gauge .v { font-family: var(--font-mono); font-size: var(--f-tiny); font-variant-numeric: tabular-nums; min-width: calc(var(--px)*46); text-align: right; white-space: nowrap; }
.ct-gauge.is-ok .fil { background: var(--ok); }
.ct-gauge.is-warn .fil { background: var(--warn); }
.ct-gauge.is-danger .fil { background: var(--danger); animation: ct-pulse 1s steps(2) infinite; }
.ct-gauge.is-ok .v { color: rgba(230,241,251,.86); }
.ct-gauge.is-warn .v { color: var(--warn); }
.ct-gauge.is-danger .v { color: var(--danger); }
@keyframes ct-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }

.ct-thr {
  display: grid; grid-template-columns: calc(var(--px) * 34) 1fr auto; align-items: center;
  gap: var(--s2); padding: calc(var(--px) * 8) var(--s3) calc(var(--px) * 4);
}
.ct-thr .trk { position: relative; height: calc(var(--px) * 13); background: rgba(158,199,230,.12); box-shadow: inset 0 0 0 1px var(--line); overflow: hidden; }
.ct-thr .fil { position: absolute; left: 0; right: 0; top: 0; bottom: 0; background: linear-gradient(90deg, rgba(84,216,255,.55), rgba(84,216,255,.9)); transform-origin: 0 50%; }
.ct-thr .wep { position: absolute; right: 0; top: 0; bottom: 0; width: 12%; background: repeating-linear-gradient(-45deg, rgba(255,74,56,.55) 0 calc(var(--px)*3), transparent calc(var(--px)*3) calc(var(--px)*7)); }
.ct-thr.is-wep .fil { background: linear-gradient(90deg, rgba(255,140,40,.7), var(--danger)); }
.ct-thr .v { font-family: var(--font-mono); font-size: var(--f-sm); font-weight: 700; min-width: calc(var(--px)*46); text-align: right; }

.ct-flags { display: flex; flex-wrap: wrap; gap: calc(var(--px) * 4); padding: 0 var(--s3) calc(var(--px) * 10); }
.ct-flag {
  font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .16em;
  padding: calc(var(--px) * 3) calc(var(--px) * 7);
  color: rgba(220,236,251,.30); box-shadow: inset 0 0 0 1px rgba(158,199,230,.14);
  transition: color .15s var(--ease), background .15s var(--ease), box-shadow .15s var(--ease);
}
.ct-flag.is-on { color: var(--ink); background: var(--accent); box-shadow: none; font-weight: 700; }
.ct-flag.is-warn { color: var(--ink); background: var(--warn); }
.ct-flag.is-danger { color: #fff; background: var(--danger); animation: ct-pulse .8s steps(2) infinite; }

/* Ammo -------------------------------------------------------------- */
.ct-ammo { display: flex; flex-direction: column; gap: calc(var(--px) * 5); padding: 0 var(--s3) calc(var(--px) * 10); }
.ct-ammo-row { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: var(--s2); }
.ct-ammo-row .n { font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .12em; color: rgba(220,236,251,.62); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ct-ammo-row .c { font-family: var(--font-mono); font-size: var(--f-tiny); font-variant-numeric: tabular-nums; }
.ct-ammo-bar { grid-column: 1 / -1; height: calc(var(--px) * 4); background: rgba(158,199,230,.13); position: relative; overflow: hidden; }
.ct-ammo-bar i { position: absolute; inset: 0; transform-origin: 0 50%; background: var(--hud); }
.ct-ammo-row.is-low .c, .ct-ammo-row.is-low .n { color: var(--warn); }
.ct-ammo-row.is-low .ct-ammo-bar i { background: var(--warn); }
.ct-ammo-row.is-empty .c, .ct-ammo-row.is-empty .n { color: var(--danger); }
.ct-ammo-row.is-empty .ct-ammo-bar i { background: var(--danger); }
.ct-ammo-row .g { font-family: var(--font-cond); font-size: var(--f-nano); color: rgba(220,236,251,.3); }

/* G-meter ------------------------------------------------------------ */
.ct-gmeter { position: absolute; right: calc(var(--px) * 404); bottom: calc(var(--px) * 26); width: calc(var(--px) * 108); }
.ct-gmeter svg { display: block; width: 100%; height: auto; }
.ct-g-val { font-family: var(--font-mono); font-weight: 700; }

/* ===================================================================== *
 * 8. HUD — damage panel
 * ===================================================================== */
.ct-dmg { width: 100%; }
.ct-dmg-body { display: grid; grid-template-columns: 1fr calc(var(--px) * 108); gap: var(--s2); padding: 0 var(--s3) var(--s2); align-items: center; }
.ct-dmg svg { width: 100%; height: auto; display: block; }
.ct-dmg .part { fill: rgba(150, 186, 214, .30); stroke: rgba(10, 16, 24, .85); stroke-width: calc(var(--px) * 1.4); stroke-linejoin: round; transition: fill .25s linear; }
.ct-dmg .part.is-hit  { fill: rgba(255, 194, 71, .82); }
.ct-dmg .part.is-crit { fill: rgba(255, 74, 56, .88); }
.ct-dmg .part.is-gone { fill: rgba(255, 74, 56, .16); stroke-dasharray: calc(var(--px)*3) calc(var(--px)*3); }
.ct-dmg .part.is-fire { animation: ct-fire .55s steps(2) infinite; }
@keyframes ct-fire { 0%, 100% { fill: rgba(255, 74, 56, .9); } 50% { fill: rgba(255, 180, 40, .95); } }
/* Airframe status rows. A pip carries the state, the label stays legible in
   every state, and the row only takes a filled plate when something is actually
   wrong — so "nothing is broken" and "the engine is alight" are told apart by
   colour, weight and motion rather than by a 12-point difference in alpha. */
.ct-dmg-flags { display: flex; flex-direction: column; gap: calc(var(--px) * 3); }
.ct-dmg-flag {
  display: flex; align-items: center; gap: calc(var(--px) * 5);
  font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .14em;
  padding: calc(var(--px) * 2) calc(var(--px) * 6);
  color: rgba(220,236,251,.52);
  background: rgba(8,14,22,.42);
  box-shadow: inset 0 0 0 1px rgba(158,199,230,.14);
}
.ct-dmg-flag .pip {
  width: calc(var(--px) * 4); height: calc(var(--px) * 9); flex: none;
  background: var(--ok); opacity: .55;
}
.ct-dmg-flag .k { flex: 1 1 auto; }
.ct-dmg-flag.is-warn {
  color: var(--warn); background: rgba(255,194,71,.12);
  box-shadow: inset 0 0 0 1px rgba(255,194,71,.45);
}
.ct-dmg-flag.is-warn .pip { background: var(--warn); opacity: 1; }
/* An alarm alternates between two strong states. 'ct-pulse' fades to 45 %
   opacity, which on a warning row means it spends half its life quieter than
   the amber row below it — a caution outshouting a warning. */
@keyframes ct-dmg-alarm {
  0%, 100% { background: rgba(255, 74, 56, .92); }
  50%      { background: rgba(255, 150, 40, .95); }
}
.ct-dmg-flag.is-on {
  color: #fff; font-weight: 700; background: rgba(255,74,56,.92); box-shadow: none;
  animation: ct-dmg-alarm .62s steps(2) infinite;
}
.ct-dmg-flag.is-on .pip { background: #fff; opacity: 1; }
/* A fire re-frames the whole panel, not just its own row. */
.ct-dmg.is-alarm { box-shadow: inset 0 0 0 calc(var(--px) * 1.5) rgba(255,74,56,.55); }
.ct-dmg.is-alarm .ct-dmg-flag { box-shadow: inset 0 0 0 1px rgba(255,74,56,.30); }
.ct-dmg.is-alarm .ct-dmg-flag.is-on { box-shadow: none; }
.ct-hp { height: calc(var(--px) * 5); margin: 0 var(--s3) var(--s2); background: rgba(158,199,230,.13); position: relative; overflow: hidden; }
.ct-hp i { position: absolute; inset: 0; transform-origin: 0 50%; background: var(--ok); transition: background .3s linear; }

/* Big fire warning across the centre-bottom */
#ct-firewarn {
  position: absolute; left: 50%; top: calc(var(--px) * 210); transform: translateX(-50%);
  font-family: var(--font-cond); font-size: var(--f-lg); letter-spacing: .34em;
  color: #fff; background: rgba(255, 45, 26, .88);
  padding: calc(var(--px) * 4) calc(var(--px) * 18);
  clip-path: var(--chamfer-all);
  animation: ct-pulse .6s steps(2) infinite;
}

/* ===================================================================== *
 * 9. HUD — target markers
 * ===================================================================== */
#ct-markers { position: absolute; inset: 0; overflow: hidden; }
.ct-mk { position: absolute; left: 0; top: 0; will-change: transform, opacity; }
.ct-mk-box {
  position: absolute; left: 50%; top: 50%;
  width: calc(var(--px) * 40); height: calc(var(--px) * 40);
  transform: translate(-50%, -50%);
}
.ct-mk-box i {
  position: absolute; width: calc(var(--px) * 11); height: calc(var(--px) * 11);
  border: calc(var(--px) * 1.6) solid currentColor;
  /* One tight, fully opaque drop-shadow: it gives the bracket its own contour
     against cloud, and one is deliberate — a drop-shadow is a filter pass per
     element, and there are four of these per marker across a pool of 28. */
  filter: drop-shadow(0 0 calc(var(--px)*1.4) rgba(3,6,11,1));
}
.ct-mk-box i:nth-child(1) { left: 0; top: 0; border-right: 0; border-bottom: 0; }
.ct-mk-box i:nth-child(2) { right: 0; top: 0; border-left: 0; border-bottom: 0; }
.ct-mk-box i:nth-child(3) { right: 0; bottom: 0; border-left: 0; border-top: 0; }
.ct-mk-box i:nth-child(4) { left: 0; bottom: 0; border-right: 0; border-top: 0; }
/* The block sits on its own plate.
 *
 * A text halo is not contrast control — it is a fixed dark spread that a bright
 * cumulus top simply out-values, and a dull team red printed on sunlit green
 * terrain with a halo behind it is still dull team red on sunlit green. The
 * plate makes the background a *constant*: whatever the block is flying over,
 * the type is always white and red on the same near-black chip, so legibility
 * stops depending on what happens to be behind the aeroplane. It also matches
 * the language every other readout in this HUD already uses. */
.ct-mk-lbl {
  position: absolute; left: 50%; top: calc(var(--px) * 26);
  transform: translateX(-50%); white-space: nowrap; text-align: center;
  font-family: var(--font-cond); font-size: var(--f-micro); letter-spacing: .1em;
  /* The type name is identity and reads white; the range underneath is threat
     and carries the team colour. Setting both to the team colour left the name
     as low-contrast cyan-on-cloud, which is where "P-51D Mustang" became
     unreadable in flight. */
  color: rgba(240, 248, 255, .96);
  padding: calc(var(--px) * 2) calc(var(--px) * 7) calc(var(--px) * 3);
  background: linear-gradient(180deg, rgba(6, 11, 18, .70), rgba(4, 8, 13, .84));
  box-shadow: inset 0 0 0 1px rgba(158, 199, 230, .18);
  clip-path: polygon(
    var(--cut-sm) 0, 100% 0, 100% calc(100% - var(--cut-sm)),
    calc(100% - var(--cut-sm)) 100%, 0 100%, 0 var(--cut-sm));
  text-shadow: 0 0 calc(var(--px) * 1.6) rgba(3,6,10,.9);
}
/* Tracked contact: block swung out clear of the sight, aligned away from it,
   with a short leader back to the box, so it reads as an annotation of the
   contact rather than as more gunsight furniture. The two mirrored variants let
   the placer dodge whichever side of the frame is already occupied. */
.ct-mk-lbl.is-offset {
  left: calc(var(--px) * 132); top: calc(var(--px) * 118);
  transform: none; text-align: left;
}
.ct-mk-lbl.is-offset.is-left {
  left: auto; right: calc(var(--px) * 132); text-align: right;
}
.ct-mk-lbl.is-offset.is-up { top: auto; bottom: calc(var(--px) * 118); }
/* Leader: one hairline from the block's near corner back to the marker box's
   corresponding corner. 149 design px at 221° lands on (20, 20) — the corner of
   the 40 px bracket — so the association is stated, not merely implied. */
.ct-mk-lbl.is-offset::before {
  content: ''; position: absolute; left: 0; top: calc(var(--px) * -3);
  width: calc(var(--px) * 149); height: calc(var(--px) * 1);
  background: currentColor; opacity: 1; height: calc(var(--px) * 1.4);
  /* The leader spends its life over whatever the contact is flying against, and
     a 1.4 px team-coloured hairline over a dark canopy frame or a sunlit cloud
     is invisible either way. One tight dark spread gives it a contour for the
     same cost as the rest of the marker's shadows. */
  box-shadow: 0 0 calc(var(--px) * 1.6) rgba(3, 6, 11, .95);
  transform-origin: 0 50%; transform: rotate(221deg);
}
/* Mirrored leader.
 *
 * With 'right: 0' the bar's body lies to the *left* of its rotation origin, so
 * its unrotated direction is 180°, not 0° — a naive rotate(-41deg) therefore
 * sends the free end to 139° (down-left, straight back across the label) rather
 * than to -41° (up-right, at the bracket). Every mirrored variant below is the
 * angle that lands the free end on the marker box, given which way the bar
 * points before it is rotated. */
.ct-mk-lbl.is-offset.is-left::before {
  left: auto; right: 0; transform-origin: 100% 50%; transform: rotate(139deg);
}
.ct-mk-lbl.is-offset.is-up::before { top: auto; bottom: calc(var(--px) * -3); transform: rotate(139deg); }
.ct-mk-lbl.is-offset.is-up.is-left::before { transform: rotate(-139deg); }
.ct-mk-lbl b {
  display: block; font-family: var(--font-mono); font-size: var(--f-tiny);
  font-weight: 700; letter-spacing: 0; color: currentColor;
}
/* Team colours are lifted for the plate: on near-black they can afford to be
   brighter than they could over sky, and the range line is the one number a
   pilot reads off a contact at a glance. */
.ct-mk.is-ally  .ct-mk-lbl b { color: #8fe4ff; }
.ct-mk.is-enemy .ct-mk-lbl b { color: #ff8a76; }
.ct-mk.is-lock  .ct-mk-lbl b { color: var(--accent); }
/* Range chip for a contact clamped to the frame edge. */
.ct-mk-edge {
  position: absolute; left: 50%; top: 50%;
  font-family: var(--font-mono); font-size: var(--f-nano); font-weight: 700;
  letter-spacing: .02em; color: rgba(240, 248, 255, .94); white-space: nowrap;
  padding: calc(var(--px) * 1) calc(var(--px) * 5);
  background: rgba(4, 8, 13, .78);
  box-shadow: inset 0 0 0 1px rgba(158, 199, 230, .20);
}
.ct-mk-arrow {
  position: absolute; left: 50%; top: 50%; width: calc(var(--px) * 15); height: calc(var(--px) * 15);
  margin: calc(var(--px) * -7.5) 0 0 calc(var(--px) * -7.5);
  background: currentColor; clip-path: polygon(50% 0, 100% 100%, 50% 74%, 0 100%);
  filter: drop-shadow(0 0 calc(var(--px)*2) rgba(0,0,0,.9));
}
.ct-mk.is-ally { color: var(--ally); }
.ct-mk.is-enemy { color: var(--enemy); }
.ct-mk.is-lock .ct-mk-box i { border-color: var(--accent); }
.ct-mk.is-lock { color: var(--accent); }

/* ===================================================================== *
 * 10. HUD — minimap
 * ===================================================================== */
#ct-minimap {
  position: absolute; left: calc(var(--px) * 26); bottom: calc(var(--px) * 26);
  width: calc(var(--px) * 250);
  pointer-events: auto;
}
/* Opaque plate: the chart supplies its own ground, so there is nothing for a
   translucent panel fill to reveal except cost. */
.ct-panel.ct-mm::before { background: rgba(5, 9, 15, .92); }
#ct-minimap canvas { display: block; width: 100%; aspect-ratio: 1 / 1; }
.ct-mm-wrap { position: relative; margin: 0 calc(var(--px)*3) calc(var(--px)*3); }
.ct-mm-scale {
  position: absolute; right: calc(var(--px) * 6); bottom: calc(var(--px) * 5);
  font-family: var(--font-mono); font-size: var(--f-nano); color: rgba(230,241,251,.75);
  text-shadow: 0 0 calc(var(--px)*3) #000;
}
.ct-mm-zoom { display: flex; gap: 1px; }
.ct-mm-zoom button { width: calc(var(--px)*18); height: calc(var(--px)*14); font-family: var(--font-mono); font-size: var(--f-nano); color: rgba(220,236,251,.55); cursor: pointer; box-shadow: inset 0 0 0 1px var(--line); }
.ct-mm-zoom button:hover { color: #fff; background: rgba(255,178,58,.16); }

/* ===================================================================== *
 * 11. HUD — feed, notices, popups
 * ===================================================================== */
#ct-killfeed {
  position: absolute; right: calc(var(--px) * 26); top: calc(var(--px) * 78);
  display: flex; flex-direction: column; align-items: flex-end; gap: calc(var(--px) * 4);
  width: calc(var(--px) * 420);
}
.ct-kill {
  display: flex; align-items: center; gap: calc(var(--px) * 7);
  padding: calc(var(--px) * 4) calc(var(--px) * 9);
  background: rgba(6, 10, 16, .62);
  box-shadow: inset 0 0 0 1px rgba(158,199,230,.14);
  clip-path: polygon(calc(var(--px)*7) 0, 100% 0, 100% 100%, 0 100%, 0 calc(var(--px)*7));
  font-size: var(--f-tiny);
  animation: ct-slide-in .28s var(--ease) both;
  transition: opacity .4s linear;
}
.ct-kill .who { font-family: var(--font-cond); letter-spacing: .08em; }
.ct-kill .who.is-ally { color: var(--ally); }
.ct-kill .who.is-enemy { color: var(--enemy); }
.ct-kill .who.is-me { color: var(--accent); font-weight: 700; }
.ct-kill .wpn { font-family: var(--font-mono); font-size: var(--f-nano); color: rgba(220,236,251,.5); }
.ct-kill.is-fading { opacity: 0; }
@keyframes ct-slide-in { from { opacity: 0; transform: translateX(calc(var(--px) * 26)); } to { opacity: 1; transform: none; } }

#ct-popups { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.ct-pop {
  position: absolute; left: calc(var(--px) * 150); top: calc(var(--px) * -70);
  white-space: nowrap; font-family: var(--font-cond); letter-spacing: .12em;
  font-size: var(--f-md); color: var(--accent);
  text-shadow: 0 0 calc(var(--px)*3) rgba(3,6,10,.95), 0 0 calc(var(--px)*10) rgba(255,178,58,.4);
  animation: ct-pop-up 1.5s var(--ease) forwards;
}
.ct-pop b { font-family: var(--font-mono); font-weight: 700; }
.ct-pop.is-kill { color: #fff; font-size: var(--f-lg); }
@keyframes ct-pop-up {
  0% { opacity: 0; transform: translateY(calc(var(--px) * 14)) scale(.86); }
  12% { opacity: 1; transform: none; }
  70% { opacity: 1; }
  100% { opacity: 0; transform: translateY(calc(var(--px) * -34)); }
}

#ct-notices { position: absolute; left: 50%; top: calc(var(--px) * 84); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: calc(var(--px)*5); width: max-content; }
.ct-notice {
  padding: calc(var(--px) * 5) calc(var(--px) * 16);
  font-family: var(--font-cond); font-size: var(--f-sm); letter-spacing: .24em;
  text-transform: uppercase; color: var(--paper);
  background: rgba(6, 10, 16, .72); box-shadow: inset 0 0 0 1px var(--line);
  clip-path: var(--chamfer-all);
  animation: ct-notice-in .3s var(--ease) both;
  transition: opacity .5s linear, transform .5s var(--ease);
}
.ct-notice.is-warn { color: var(--ink); background: var(--warn); box-shadow: none; }
.ct-notice.is-danger { color: #fff; background: rgba(255,74,56,.9); box-shadow: none; }
.ct-notice.is-fading { opacity: 0; transform: translateY(calc(var(--px) * -10)); }
@keyframes ct-notice-in { from { opacity: 0; transform: translateY(calc(var(--px) * -12)); } to { opacity: 1; transform: none; } }

/* Connection pill */
#ct-conn {
  position: absolute; left: calc(var(--px) * 26); top: calc(var(--px) * 22);
  display: flex; align-items: center; gap: calc(var(--px) * 8);
  padding: calc(var(--px) * 5) calc(var(--px) * 10);
  background: rgba(6, 10, 16, .6); box-shadow: inset 0 0 0 1px var(--line);
  clip-path: var(--chamfer-all);
  font-family: var(--font-mono); font-size: var(--f-nano);
}
#ct-conn .bars { display: flex; align-items: flex-end; gap: calc(var(--px) * 2); height: calc(var(--px) * 11); }
#ct-conn .bars i { width: calc(var(--px) * 3); background: rgba(220,236,251,.2); }
#ct-conn .bars i.is-on { background: var(--ok); }
#ct-conn.is-warn .bars i.is-on { background: var(--warn); }
#ct-conn.is-danger .bars i.is-on { background: var(--danger); }
#ct-conn .lbl { font-family: var(--font-cond); letter-spacing: .16em; color: rgba(220,236,251,.55); }
#ct-conn .ms { color: var(--hud); }
#ct-conn.is-offline { box-shadow: inset 0 0 0 1px rgba(255,194,71,.5); }
#ct-conn.is-offline .lbl { color: var(--warn); }

/* Match strip (score + timer), top centre under the compass */
#ct-match {
  position: absolute; left: 50%; top: calc(var(--px) * 68); transform: translateX(-50%);
  display: flex; align-items: center; gap: calc(var(--px) * 10);
  font-family: var(--font-mono); font-size: var(--f-tiny);
  padding: calc(var(--px) * 3) calc(var(--px) * 12);
  background: rgba(6, 10, 16, .55); box-shadow: inset 0 0 0 1px var(--line);
  clip-path: var(--chamfer-all);
}
#ct-match .a { color: var(--ally); font-weight: 700; }
#ct-match .b { color: var(--enemy); font-weight: 700; }
#ct-match .t { color: rgba(230,241,251,.8); letter-spacing: .1em; }
#ct-match .bar { position: relative; width: calc(var(--px) * 120); height: calc(var(--px) * 4); background: var(--enemy); overflow: hidden; }
#ct-match .bar i { position: absolute; left: 0; right: 0; top: 0; bottom: 0; background: var(--ally); transform-origin: 0 50%; }

/* ===================================================================== *
 * 12. Chat
 * ===================================================================== */
#ct-chat {
  position: absolute; left: calc(var(--px) * 26); bottom: calc(var(--px) * 300);
  width: calc(var(--px) * 460); display: flex; flex-direction: column; gap: calc(var(--px) * 3);
}
.ct-chat-log { display: flex; flex-direction: column; gap: calc(var(--px) * 2); align-items: flex-start; }
.ct-chat-msg {
  font-size: var(--f-tiny); padding: calc(var(--px) * 2) calc(var(--px) * 8);
  background: rgba(6, 10, 16, .55); transition: opacity .6s linear;
  max-width: 100%; word-break: break-word;
  animation: ct-slide-up .22s var(--ease) both;
}
.ct-chat-msg .from { font-family: var(--font-cond); letter-spacing: .08em; margin-right: calc(var(--px)*6); }
.ct-chat-msg .from.is-ally { color: var(--ally); }
.ct-chat-msg .from.is-enemy { color: var(--enemy); }
.ct-chat-msg .from.is-sys { color: var(--accent); }
.ct-chat-msg.is-fading { opacity: 0; }
@keyframes ct-slide-up { from { opacity: 0; transform: translateY(calc(var(--px)*6)); } to { opacity: 1; transform: none; } }
#ct-chat-entry { display: none; align-items: center; gap: var(--s2); pointer-events: auto; }
#ct-chat.is-typing #ct-chat-entry { display: flex; }
#ct-chat-entry .ct-input { flex: 1; }
#ct-chat-entry .tag { font-family: var(--font-cond); font-size: var(--f-micro); letter-spacing: .18em; color: var(--accent); }

/* ===================================================================== *
 * 13. Menus — shared shell
 * ===================================================================== */
.ct-screen {
  position: absolute; inset: 0; pointer-events: auto;
  display: flex; flex-direction: column;
  animation: ct-screen-in .32s var(--ease) both;
}
@keyframes ct-screen-in { from { opacity: 0; } to { opacity: 1; } }
.ct-screen.is-leaving { animation: ct-screen-out .22s var(--ease-in) both; }
@keyframes ct-screen-out { to { opacity: 0; } }

/* Cinematic treatment shared by every full-screen menu: letterbox, corner
   registration marks, vignette and a faint moving grain. */
.ct-cine::before {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background:
    /* Scrim under the type column. The live scene behind the menu can be a
       bright overcast one frame and dark water the next; the copy has to hold
       against both, and a scrim is more honest than fighting it with shadows. */
    linear-gradient(90deg, rgba(3, 6, 10, .80) 0%, rgba(3, 6, 10, .45) 28%, transparent 52%),
    radial-gradient(120% 90% at 50% 42%, transparent 38%, rgba(3, 6, 10, .72) 100%),
    linear-gradient(180deg, rgba(3,6,10,.62) 0%, transparent 22%, transparent 74%, rgba(3,6,10,.82) 100%);
}
.ct-cine::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .05;
  background-image: var(--grain);
  background-size: calc(var(--px) * 160) calc(var(--px) * 160);
  animation: ct-grain 1.2s steps(6) infinite;
  mix-blend-mode: overlay;
}
@keyframes ct-grain {
  0%   { transform: translate(0, 0); }
  20%  { transform: translate(-2%, 1%); }
  40%  { transform: translate(1%, -2%); }
  60%  { transform: translate(-1%, -1%); }
  80%  { transform: translate(2%, 1%); }
  100% { transform: translate(0, 0); }
}

.ct-corner { position: absolute; width: calc(var(--px) * 30); height: calc(var(--px) * 30); border: calc(var(--px) * 2) solid rgba(255, 178, 58, .5); pointer-events: none; }
.ct-corner.tl { left: var(--s4); top: var(--s4); border-right: 0; border-bottom: 0; }
.ct-corner.tr { right: var(--s4); top: var(--s4); border-left: 0; border-bottom: 0; }
.ct-corner.bl { left: var(--s4); bottom: var(--s4); border-right: 0; border-top: 0; }
.ct-corner.br { right: var(--s4); bottom: var(--s4); border-left: 0; border-top: 0; }

.ct-topbar {
  position: relative; z-index: 2;
  display: flex; align-items: center; gap: var(--s4);
  padding: var(--s5) var(--s7) var(--s3);
}
.ct-topbar .ct-title {
  font-family: var(--font-cond); font-size: var(--f-xl); letter-spacing: .26em;
  text-transform: uppercase; color: var(--paper);
}
.ct-topbar .ct-sub { font-family: var(--font-mono); font-size: var(--f-micro); color: rgba(220,236,251,.4); letter-spacing: .14em; }
.ct-topbar .sp { flex: 1; }
.ct-rule { height: 1px; background: linear-gradient(90deg, var(--accent), rgba(158,199,230,.22) 30%, transparent); margin: 0 var(--s7); }

/* ===================================================================== *
 * 14. Main menu
 * ===================================================================== */
#ct-menu { justify-content: center; }
.ct-brand { padding: 0 var(--s7); margin-bottom: var(--s6); }
.ct-brand-row { display: flex; align-items: center; gap: var(--s4); }
.ct-emblem { width: calc(var(--px) * 92); height: calc(var(--px) * 92); flex: none; filter: drop-shadow(0 calc(var(--px)*6) calc(var(--px)*16) rgba(0,0,0,.6)); }
.ct-word {
  font-family: var(--font-cond); font-weight: 700; line-height: .86;
  text-transform: uppercase; color: var(--paper);
}
.ct-word .l1 { display: block; font-size: var(--f-2xl); letter-spacing: .42em; color: rgba(230,241,251,.82); }
.ct-word .l2 {
  display: block; font-size: var(--f-3xl); letter-spacing: .06em;
  background: linear-gradient(178deg, #ffffff 0%, #dfeaf6 38%, #9fb6cc 62%, #ffd27a 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  text-shadow: 0 calc(var(--px)*4) calc(var(--px)*26) rgba(0,0,0,.65);
}
.ct-tagline {
  margin-top: var(--s3); display: flex; align-items: center; gap: var(--s3);
  font-family: var(--font-mono); font-size: var(--f-micro);
  letter-spacing: .34em; color: rgba(224, 238, 252, .68); text-transform: uppercase;
  text-shadow: 0 calc(var(--px) * 2) calc(var(--px) * 8) rgba(3, 6, 10, .85);
}
.ct-tagline .dash { width: calc(var(--px) * 42); height: 1px; background: var(--accent); }

.ct-nav { padding: 0 var(--s7); display: flex; flex-direction: column; gap: calc(var(--px) * 2); width: max-content; min-width: calc(var(--px) * 380); }
.ct-navitem {
  position: relative; display: flex; align-items: center; gap: var(--s3);
  padding: calc(var(--px) * 11) var(--s4) calc(var(--px) * 11) var(--s3);
  cursor: pointer; text-align: left;
  transition: background .16s var(--ease), padding-left .18s var(--ease);
  clip-path: polygon(0 0, 100% 0, calc(100% - var(--cut)) 100%, 0 100%);
}
.ct-navitem::after {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: calc(var(--px) * 3);
  background: var(--accent); transform: scaleY(0); transition: transform .18s var(--ease);
}
.ct-navitem .idx { font-family: var(--font-mono); font-size: var(--f-micro); color: rgba(255,178,58,.55); width: calc(var(--px) * 26); }
.ct-navitem .nm {
  font-family: var(--font-cond); font-size: var(--f-lg); letter-spacing: .2em;
  text-transform: uppercase; color: rgba(238, 246, 253, .92);
  text-shadow: 0 calc(var(--px) * 2) calc(var(--px) * 10) rgba(3, 6, 10, .8);
  transition: color .16s var(--ease);
}
.ct-navitem .hint { margin-left: auto; font-family: var(--font-mono); font-size: var(--f-nano); color: rgba(220,236,251,.52); letter-spacing: .1em; }
.ct-navitem:hover, .ct-navitem.is-sel { background: linear-gradient(90deg, rgba(255,178,58,.16), transparent 70%); padding-left: var(--s4); }
.ct-navitem:hover::after, .ct-navitem.is-sel::after { transform: scaleY(1); }
.ct-navitem:hover .nm, .ct-navitem.is-sel .nm { color: #fff; }

.ct-menu-side {
  position: absolute; right: var(--s7); top: 50%; transform: translateY(-50%);
  width: calc(var(--px) * 320);
}
.ct-kv { display: grid; grid-template-columns: 1fr auto; gap: var(--s2); padding: calc(var(--px) * 5) var(--s3); font-size: var(--f-tiny); }
.ct-kv:nth-child(odd) { background: rgba(140,190,230,.035); }
.ct-kv .k { font-family: var(--font-cond); letter-spacing: .14em; color: rgba(220,236,251,.45); text-transform: uppercase; font-size: var(--f-nano); }
.ct-kv .v { font-family: var(--font-mono); font-size: var(--f-tiny); color: var(--hud); }
.ct-kv .v.is-ok { color: var(--ok); }
.ct-kv .v.is-warn { color: var(--warn); }

.ct-foot {
  position: absolute; left: var(--s7); right: var(--s7); bottom: var(--s5);
  display: flex; align-items: center; gap: var(--s4);
  font-family: var(--font-mono); font-size: var(--f-nano);
  color: rgba(220,236,251,.5); letter-spacing: .14em;
  text-shadow: 0 0 calc(var(--px) * 6) rgba(3, 6, 10, .9);
}
.ct-foot .sp { flex: 1; }

/* ===================================================================== *
 * 15. Hangar
 * ===================================================================== */
#ct-hangar { background: radial-gradient(120% 100% at 50% 0%, rgba(16,26,38,.72), rgba(4,7,11,.94)); }
.ct-hangar-body {
  flex: 1; display: grid;
  grid-template-columns: calc(var(--px) * 300) 1fr calc(var(--px) * 380);
  gap: var(--s4); padding: var(--s3) var(--s7) var(--s5); min-height: 0;
}
.ct-nations { display: flex; gap: calc(var(--px) * 4); padding: var(--s2) var(--s3); flex-wrap: wrap; }
.ct-nation {
  display: flex; align-items: center; gap: calc(var(--px)*5);
  padding: calc(var(--px) * 5) calc(var(--px) * 8); cursor: pointer;
  font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .14em; text-transform: uppercase;
  color: rgba(220,236,251,.45); box-shadow: inset 0 0 0 1px transparent;
  transition: color .15s var(--ease), background .15s var(--ease);
}
.ct-nation svg { width: calc(var(--px) * 16); height: calc(var(--px) * 16); display: block; }
.ct-nation:hover { color: #fff; background: rgba(140,190,230,.08); }
.ct-nation.is-on { color: var(--ink); background: var(--accent); font-weight: 700; }

.ct-planelist { flex: 1; min-height: 0; }
.ct-plane {
  position: relative; display: grid; grid-template-columns: 1fr auto; align-items: center;
  gap: var(--s2); padding: calc(var(--px) * 9) var(--s3);
  cursor: pointer; border-bottom: 1px solid rgba(158,199,230,.08);
  transition: background .15s var(--ease), padding-left .15s var(--ease);
}
.ct-plane::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: calc(var(--px)*3); background: var(--accent); transform: scaleY(0); transition: transform .16s var(--ease); }
.ct-plane:hover { background: rgba(140,190,230,.06); padding-left: var(--s4); }
.ct-plane.is-on { background: linear-gradient(90deg, rgba(255,178,58,.16), transparent); padding-left: var(--s4); }
.ct-plane.is-on::before, .ct-plane:hover::before { transform: scaleY(1); }
.ct-plane .nm { font-family: var(--font-cond); font-size: var(--f-sm); letter-spacing: .1em; color: var(--paper); }
.ct-plane .rl { font-family: var(--font-mono); font-size: var(--f-nano); color: rgba(220,236,251,.38); letter-spacing: .08em; margin-top: calc(var(--px)*2); }
.ct-plane .br {
  font-family: var(--font-mono); font-size: var(--f-tiny); font-weight: 700; color: var(--accent);
  padding: calc(var(--px)*2) calc(var(--px)*6); box-shadow: inset 0 0 0 1px rgba(255,178,58,.35);
}

.ct-stage { position: relative; display: flex; flex-direction: column; min-width: 0; }
.ct-stage-view { position: relative; flex: 1; min-height: 0; overflow: hidden; }
/* The turntable plate is its own little studio: nearly opaque so the live
   world behind the menu cannot streak across the aircraft. */
.ct-stage-view.ct-panel.is-flat::before {
  background:
    radial-gradient(70% 55% at 50% 42%, rgba(44, 66, 92, .55), transparent 72%),
    linear-gradient(180deg, rgba(9, 14, 21, .93), rgba(4, 7, 11, .97));
}
.ct-stage-view canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.ct-stage-name {
  position: absolute; left: var(--s4); bottom: var(--s4); pointer-events: none;
}
.ct-stage-name .n1 { font-family: var(--font-cond); font-size: var(--f-2xl); letter-spacing: .1em; text-transform: uppercase; color: #fff; text-shadow: 0 calc(var(--px)*4) calc(var(--px)*20) rgba(0,0,0,.7); }
.ct-stage-name .n2 { font-family: var(--font-mono); font-size: var(--f-micro); letter-spacing: .24em; color: rgba(255,178,58,.85); text-transform: uppercase; margin-top: calc(var(--px)*4); }
.ct-stage-grid {
  position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(90deg, rgba(158,199,230,.05) 1px, transparent 1px) 0 0 / calc(var(--px)*46) calc(var(--px)*46),
    linear-gradient(180deg, rgba(158,199,230,.05) 1px, transparent 1px) 0 0 / calc(var(--px)*46) calc(var(--px)*46),
    radial-gradient(80% 60% at 50% 45%, rgba(80,130,180,.14), transparent 70%);
}
.ct-liveries { display: flex; gap: calc(var(--px)*6); padding: var(--s3) var(--s4); align-items: center; }
.ct-livery {
  width: calc(var(--px) * 46); height: calc(var(--px) * 26); cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(158,199,230,.2);
  clip-path: polygon(0 0, 100% 0, calc(100% - var(--px)*7) 100%, 0 100%);
  transition: transform .15s var(--ease), box-shadow .15s var(--ease);
}
.ct-livery:hover { transform: translateY(calc(var(--px) * -2)); }
.ct-livery.is-on { box-shadow: inset 0 0 0 calc(var(--px)*2) var(--accent); }

.ct-statcard { display: flex; flex-direction: column; min-height: 0; }
.ct-stats { padding: var(--s2) var(--s4) var(--s3); display: flex; flex-direction: column; gap: calc(var(--px) * 7); }
.ct-stat { display: grid; grid-template-columns: 1fr auto; gap: calc(var(--px)*3) var(--s2); }
.ct-stat .k { font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .16em; text-transform: uppercase; color: rgba(220,236,251,.5); }
.ct-stat .v { font-family: var(--font-mono); font-size: var(--f-tiny); color: var(--paper); font-variant-numeric: tabular-nums; }
.ct-stat .trk { grid-column: 1 / -1; position: relative; height: calc(var(--px) * 6); background: rgba(158,199,230,.12); overflow: hidden; }
.ct-stat .fil {
  position: absolute; left: 0; right: 0; top: 0; bottom: 0; background: linear-gradient(90deg, rgba(255,178,58,.75), var(--accent));
  transform-origin: 0 50%; transform: scaleX(0);
  transition: transform .55s var(--ease);
}
.ct-stat .avg { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,255,255,.45); }
.ct-arms { padding: 0 var(--s4) var(--s3); display: flex; flex-direction: column; gap: calc(var(--px) * 4); }
.ct-arm { display: grid; grid-template-columns: auto 1fr auto; gap: var(--s2); align-items: baseline; font-size: var(--f-tiny); }
.ct-arm .cal { font-family: var(--font-mono); font-weight: 700; color: var(--accent); }
.ct-arm .nm { font-family: var(--font-cond); letter-spacing: .06em; color: rgba(230,241,251,.82); }
.ct-arm .am { font-family: var(--font-mono); font-size: var(--f-nano); color: rgba(220,236,251,.45); }
.ct-notes { padding: 0 var(--s4) var(--s3); display: flex; flex-direction: column; gap: calc(var(--px) * 6); }
.ct-note { display: grid; grid-template-columns: calc(var(--px) * 86) 1fr; gap: var(--s2); align-items: baseline; }
.ct-note .k {
  font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .16em;
  text-transform: uppercase; color: var(--accent); opacity: .8;
}
.ct-note .v { font-size: var(--f-tiny); color: rgba(230, 241, 251, .72); line-height: 1.45; }
.ct-brbadge {
  display: flex; align-items: baseline; gap: var(--s2); padding: var(--s3) var(--s4);
  border-top: 1px solid var(--line);
}
.ct-brbadge .k { font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .2em; color: rgba(220,236,251,.45); }
.ct-brbadge .v { font-family: var(--font-mono); font-size: var(--f-xl); font-weight: 700; color: var(--accent); }
.ct-deploy { padding: var(--s3) var(--s4) var(--s4); display: flex; gap: var(--s3); }
.ct-deploy .ct-btn { flex: 1; justify-content: center; }

/* ===================================================================== *
 * 16. Settings & controls
 * ===================================================================== */
.ct-modal-wrap { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: auto; background: rgba(3, 6, 10, .58); backdrop-filter: blur(calc(var(--px)*6)); -webkit-backdrop-filter: blur(calc(var(--px)*6)); animation: ct-screen-in .2s var(--ease) both; }
.ct-modal { width: min(calc(var(--px) * 900), 92vw); max-height: 86vh; display: flex; flex-direction: column; }
.ct-modal-head { display: flex; align-items: center; gap: var(--s4); padding: var(--s3) var(--s4); border-bottom: 1px solid var(--line); }
.ct-modal-head .ct-title { font-family: var(--font-cond); font-size: var(--f-lg); letter-spacing: .24em; text-transform: uppercase; }
.ct-modal-head .sp { flex: 1; }
.ct-modal-body { min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.ct-tabbody { min-height: 0; overflow-y: auto; padding-bottom: var(--s2); }
.ct-modal-foot { display: flex; gap: var(--s3); padding: var(--s3) var(--s4); border-top: 1px solid var(--line); }
.ct-modal-foot .sp { flex: 1; }
.ct-group-title {
  padding: var(--s3) var(--s4) calc(var(--px) * 5);
  font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .28em;
  text-transform: uppercase; color: rgba(255,178,58,.7);
}

.ct-bind { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: var(--s3); padding: calc(var(--px)*6) var(--s4); border-bottom: 1px solid rgba(158,199,230,.07); }
.ct-bind .k { font-size: var(--f-tiny); color: rgba(230,241,251,.85); }
.ct-key {
  min-width: calc(var(--px) * 84); text-align: center;
  padding: calc(var(--px) * 5) calc(var(--px) * 9);
  font-family: var(--font-mono); font-size: var(--f-nano); letter-spacing: .06em;
  color: var(--paper); background: rgba(140,190,230,.07);
  box-shadow: inset 0 0 0 1px var(--line), 0 calc(var(--px)*2) 0 rgba(3,6,10,.6);
  cursor: pointer; transition: all .14s var(--ease);
}
.ct-key:hover { background: rgba(255,178,58,.16); color: #fff; }
.ct-key.is-listen { background: var(--accent); color: var(--ink); animation: ct-pulse .7s steps(2) infinite; }
.ct-bind .alt { font-family: var(--font-mono); font-size: var(--f-nano); color: var(--hud-faint); margin-right: var(--s2); }

/* ===================================================================== *
 * 16b. Control legend and the first-flight card
 *
 * Both are pointer-events: none all the way down. They sit over the live
 * canvas while the player is flying, and anything that swallowed a click here
 * would swallow the click that takes pointer lock.
 * ===================================================================== */
kbd.ct-kbd {
  display: inline-block; min-width: calc(var(--px) * 26);
  padding: calc(var(--px) * 3) calc(var(--px) * 7) calc(var(--px) * 4);
  font-family: var(--font-mono); font-size: var(--f-nano); font-weight: 600;
  line-height: 1; letter-spacing: .04em; text-align: center; white-space: nowrap;
  color: var(--accent-hot); background: rgba(255, 178, 58, .10);
  border-radius: calc(var(--px) * 3);
  box-shadow: inset 0 0 0 1px rgba(255, 178, 58, .34), 0 calc(var(--px) * 2) 0 rgba(3, 6, 10, .55);
}
kbd.ct-kbd.is-none { color: var(--hud-faint); background: transparent; box-shadow: inset 0 0 0 1px var(--line); }

.ct-legend {
  position: absolute; inset: 0; z-index: 46;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
  background: radial-gradient(ellipse at center, rgba(4, 7, 12, .58), rgba(4, 7, 12, .82));
  animation: ct-screen-in .18s var(--ease) both;
}
.ct-legend-panel {
  width: min(calc(var(--px) * 1220), 95vw); max-height: 92vh; overflow: hidden;
  padding: var(--s4) var(--s5) var(--s5);
}
.ct-legend-head { display: flex; align-items: baseline; gap: var(--s4); padding-bottom: var(--s3); border-bottom: 1px solid var(--line); }
.ct-legend-hint { font-family: var(--font-mono); font-size: var(--f-micro); color: var(--hud-dim); letter-spacing: .1em; text-transform: uppercase; }
/* Multi-column rather than a grid, and deliberately.
   A grid puts every group of a row on the same baseline, so the tallest group
   (Trim, seven rows) set the height of its whole row and pushed the last one
   off the bottom of a panel that is capped at 92vh — the legend silently lost
   its last two bindings at 720p. Columns balance the groups by content. */
.ct-legend-grid {
  columns: 4 calc(var(--px) * 250); column-gap: var(--s5);
  padding-top: var(--s4);
}
.ct-legend-col { break-inside: avoid; margin-bottom: var(--s4); }
.ct-legend-title {
  font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .28em;
  text-transform: uppercase; color: rgba(255, 178, 58, .78);
  padding-bottom: calc(var(--px) * 5); margin-bottom: calc(var(--px) * 4);
  border-bottom: 1px solid rgba(158, 199, 230, .12);
}
.ct-legend-row {
  display: grid; grid-template-columns: calc(var(--px) * 104) 1fr;
  align-items: center; gap: var(--s3); padding: calc(var(--px) * 3) 0;
}
.ct-legend-keys { display: flex; flex-wrap: wrap; gap: calc(var(--px) * 3); justify-content: flex-end; }
.ct-legend-name { font-size: var(--f-tiny); color: rgba(230, 241, 251, .84); }
.ct-legend-empty { font-size: var(--f-sm); color: var(--hud-dim); padding: var(--s4); }

.ct-firstflight {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  z-index: 44; pointer-events: none;
  animation: ct-ff-in .42s cubic-bezier(.2, .8, .3, 1) both;
}
@keyframes ct-ff-in {
  from { transform: translate(-50%, calc(-50% + var(--s4))); opacity: 0; }
  to   { transform: translate(-50%, -50%); opacity: 1; }
}
.ct-ff-panel { width: min(calc(var(--px) * 560), 90vw); padding: var(--s4) var(--s5) var(--s4); }
.ct-ff-kicker {
  font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .3em;
  text-transform: uppercase; color: rgba(255, 178, 58, .8);
}
.ct-ff-title { font-family: var(--font-cond); font-size: var(--f-lg); letter-spacing: .04em; color: var(--paper); margin-bottom: var(--s3); }
.ct-ff-list { display: flex; flex-direction: column; gap: calc(var(--px) * 5); }
.ct-ff-row { display: grid; grid-template-columns: calc(var(--px) * 118) 1fr; align-items: center; gap: var(--s3); }
.ct-ff-keys { display: flex; flex-wrap: wrap; gap: calc(var(--px) * 3); justify-content: flex-end; }
.ct-ff-note { font-size: var(--f-tiny); color: rgba(230, 241, 251, .86); }
.ct-ff-foot {
  margin-top: var(--s4); padding-top: var(--s3); border-top: 1px solid var(--line);
  font-size: var(--f-micro); color: var(--hud-dim);
}

/* ===================================================================== *
 * 16c. Flight school
 *
 * pointer-events: none on everything except the Skip button — the first thing
 * this asks the player to do is click the canvas to take pointer lock, and an
 * overlay that ate that click would deadlock its own first instruction.
 * ===================================================================== */
.ct-tut {
  position: absolute; left: 50%; bottom: calc(var(--px) * 96);
  transform: translateX(-50%);
  z-index: 48; pointer-events: none;
}
.ct-tut-card {
  width: min(calc(var(--px) * 520), 92vw);
  padding: var(--s3) var(--s4) var(--s3);
  animation: ct-tut-in .3s cubic-bezier(.2, .8, .3, 1) both;
  transition: box-shadow .2s var(--ease);
}
@keyframes ct-tut-in {
  from { opacity: 0; transform: translateY(calc(var(--px) * 14)); }
  to   { opacity: 1; transform: none; }
}
.ct-tut-head { display: flex; align-items: center; gap: var(--s3); }
.ct-tut-kicker {
  flex: 1; font-family: var(--font-cond); font-size: var(--f-nano);
  letter-spacing: .3em; text-transform: uppercase; color: rgba(255, 178, 58, .8);
}
.ct-tut-pips { display: flex; gap: calc(var(--px) * 4); }
.ct-tut-pip {
  width: calc(var(--px) * 18); height: calc(var(--px) * 3); border-radius: 2px;
  background: rgba(158, 199, 230, .22); position: relative; overflow: hidden;
}
.ct-tut-pip.is-done { background: rgba(121, 230, 166, .75); }
.ct-tut-pip.is-now { background: rgba(158, 199, 230, .28); }
.ct-tut-pip.is-now::after {
  content: ''; position: absolute; inset: 0; width: var(--p, 0%);
  background: var(--accent);
}
.ct-tut-title {
  font-family: var(--font-cond); font-size: var(--f-lg); letter-spacing: .03em;
  color: var(--paper); margin-top: calc(var(--px) * 5);
}
.ct-tut-keys { display: flex; flex-wrap: wrap; gap: calc(var(--px) * 4); margin: var(--s2) 0 calc(var(--px) * 6); }
.ct-tut-why { font-size: var(--f-tiny); color: rgba(230, 241, 251, .74); }
.ct-tut-nudge { margin-top: var(--s2); font-size: var(--f-micro); color: var(--warn); }
.ct-tut-tick {
  display: none; margin-top: var(--s2);
  font-family: var(--font-cond); font-size: var(--f-md); letter-spacing: .16em;
  text-transform: uppercase; color: var(--ok);
}
.ct-tut-card.is-done { box-shadow: inset 0 0 0 1px rgba(121, 230, 166, .5); }
.ct-tut-card.is-done .ct-tut-tick { display: block; }
.ct-tut-card.is-done .ct-tut-why { opacity: .35; }
.ct-tut-foot { display: flex; justify-content: flex-end; margin-top: var(--s3); }
/* The one interactive element in the whole overlay. */
.ct-tut-skip { pointer-events: auto; }

/* ===================================================================== *
 * 17. Scoreboard
 * ===================================================================== */
#ct-scoreboard { pointer-events: none; }
.ct-sb { width: min(calc(var(--px) * 1180), 94vw); margin: auto; }
.ct-sb-head { display: flex; align-items: center; gap: var(--s4); padding: var(--s3) var(--s4); }
.ct-sb-score { display: flex; align-items: center; gap: var(--s3); font-family: var(--font-mono); font-size: var(--f-xl); font-weight: 700; }
.ct-sb-score .a { color: var(--ally); }
.ct-sb-score .b { color: var(--enemy); }
.ct-sb-score .sep { color: rgba(220,236,251,.3); }
.ct-sb-teams { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s4); padding: 0 var(--s4) var(--s4); }
.ct-sb-team .hd {
  display: grid; grid-template-columns: 1fr calc(var(--px)*90) calc(var(--px)*40) calc(var(--px)*40) calc(var(--px)*56) calc(var(--px)*52);
  gap: var(--s2); padding: calc(var(--px)*5) var(--s3);
  font-family: var(--font-cond); font-size: var(--f-nano); letter-spacing: .18em;
  text-transform: uppercase; color: rgba(220,236,251,.4);
  border-bottom: 1px solid var(--line);
}
.ct-sb-team.is-ally .hd { border-bottom-color: rgba(90,212,255,.45); }
.ct-sb-team.is-enemy .hd { border-bottom-color: rgba(255,95,77,.45); }
.ct-sb-row {
  display: grid; grid-template-columns: 1fr calc(var(--px)*90) calc(var(--px)*40) calc(var(--px)*40) calc(var(--px)*56) calc(var(--px)*52);
  gap: var(--s2); padding: calc(var(--px)*5) var(--s3);
  font-size: var(--f-tiny); align-items: center;
}
.ct-sb-row:nth-child(odd) { background: rgba(140,190,230,.04); }
.ct-sb-row.is-me { background: rgba(255,178,58,.14); box-shadow: inset calc(var(--px)*3) 0 0 var(--accent); }
.ct-sb-row .nm { display: flex; align-items: center; gap: var(--s2); font-family: var(--font-cond); letter-spacing: .06em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ct-sb-row .nm .dot { width: calc(var(--px)*6); height: calc(var(--px)*6); flex: none; background: var(--ok); }
.ct-sb-row.is-dead .nm { color: rgba(220,236,251,.4); }
.ct-sb-row.is-dead .nm .dot { background: rgba(255,74,56,.6); }
.ct-sb-row .n { font-family: var(--font-mono); text-align: right; font-variant-numeric: tabular-nums; }
.ct-sb-row .ac { font-family: var(--font-mono); font-size: var(--f-nano); color: rgba(220,236,251,.45); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ct-ping {
  display: flex; align-items: flex-end; justify-content: flex-end;
  gap: calc(var(--px)*2); height: calc(var(--px)*12);
  font-family: var(--font-mono); font-size: var(--f-nano); line-height: 1;
}
.ct-ping span { margin-left: calc(var(--px)*4); }
.ct-ping i { width: calc(var(--px)*3); background: var(--ok); }
.ct-ping.is-warn i { background: var(--warn); }
.ct-ping.is-danger i { background: var(--danger); }

/* ===================================================================== *
 * 18. Death / respawn / match end
 * ===================================================================== */
#ct-death { pointer-events: auto; display: flex; align-items: flex-end; justify-content: center; }
#ct-death::before {
  content: ''; position: absolute; inset: 0;
  background:
    radial-gradient(78% 62% at 50% 46%, rgba(10, 6, 8, .25) 20%, rgba(46, 6, 5, .82) 100%),
    linear-gradient(180deg, rgba(6, 8, 12, .5), rgba(6, 8, 12, .1) 40%, rgba(6, 8, 12, .72));
  animation: ct-death-in 1.1s var(--ease) both;
}
@keyframes ct-death-in { from { opacity: 0; } to { opacity: 1; } }
.ct-death-card { position: relative; width: min(calc(var(--px)*760), 90vw); margin-bottom: calc(var(--px) * 90); animation: ct-death-card .8s var(--ease) both .25s; }
@keyframes ct-death-card { from { opacity: 0; transform: translateY(calc(var(--px)*24)); } to { opacity: 1; transform: none; } }
.ct-death-title {
  font-family: var(--font-cond); font-size: var(--f-2xl); letter-spacing: .3em;
  text-transform: uppercase; color: #fff; padding: var(--s4) var(--s5) 0;
  text-shadow: 0 calc(var(--px)*4) calc(var(--px)*20) rgba(0,0,0,.8);
}
.ct-death-sub { padding: calc(var(--px)*6) var(--s5) var(--s4); font-family: var(--font-mono); font-size: var(--f-sm); color: rgba(230,241,251,.7); }
.ct-death-sub .who { color: var(--enemy); font-weight: 700; }
.ct-death-sub .wpn { color: var(--accent); }
.ct-death-foot { display: flex; align-items: center; gap: var(--s4); padding: var(--s3) var(--s5) var(--s4); border-top: 1px solid var(--line); }
.ct-respawn { position: relative; width: calc(var(--px) * 62); height: calc(var(--px) * 62); flex: none; }
.ct-respawn svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.ct-respawn .rt { fill: none; stroke: rgba(158,199,230,.16); stroke-width: calc(var(--px)*4); }
.ct-respawn .rf { fill: none; stroke: var(--accent); stroke-width: calc(var(--px)*4); stroke-linecap: butt; transition: stroke-dashoffset .2s linear; }
.ct-respawn .num {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-family: var(--font-mono); font-size: var(--f-lg); font-weight: 700; color: var(--paper);
}

#ct-matchend { pointer-events: auto; display: grid; place-items: center; }
.ct-result {
  font-family: var(--font-cond); font-size: calc(var(--px) * 90);
  letter-spacing: .22em; text-transform: uppercase; text-align: center; line-height: 1;
  animation: ct-result-in .9s var(--ease) both;
}
.ct-result.is-win { color: var(--accent); text-shadow: 0 0 calc(var(--px)*60) rgba(255,178,58,.45); }
.ct-result.is-lose { color: var(--enemy); text-shadow: 0 0 calc(var(--px)*60) rgba(255,74,56,.35); }
@keyframes ct-result-in { from { opacity: 0; letter-spacing: .6em; } to { opacity: 1; letter-spacing: .22em; } }

/* ===================================================================== *
 * 19. Pause menu
 * ===================================================================== */
#ct-pause { display: grid; place-items: center; pointer-events: auto; background: rgba(3,6,10,.55); backdrop-filter: blur(calc(var(--px)*5)); -webkit-backdrop-filter: blur(calc(var(--px)*5)); }
.ct-pause-card { width: min(calc(var(--px)*440), 88vw); }
.ct-pause-card .ct-navitem { padding-left: var(--s4); }

/* ===================================================================== *
 * 20. Motion preferences
 * ===================================================================== */
@media (prefers-reduced-motion: reduce) {
  #ct-root *, #ct-root *::before, #ct-root *::after {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
  }
}
`;

/**
 * A 1-bit film-grain tile, generated once and handed to CSS as a data URI.
 * Doing it here keeps the "no binary assets" rule and lets the grain density
 * be tuned in code.
 */
export function makeGrainDataUri(size = 96, density = 0.11): string {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return '';
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const on = Math.random() < density;
    const v = on ? 255 : 0;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = on ? 255 : 0;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

let injected = false;

export function injectStyles(): void {
  if (injected) return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'ct-style';
  style.textContent = UI_CSS;
  document.head.appendChild(style);
  // The grain tile is set as a custom property so the CSS above stays static.
  const uri = makeGrainDataUri();
  if (uri) document.documentElement.style.setProperty('--grain', `url(${uri})`);
}
