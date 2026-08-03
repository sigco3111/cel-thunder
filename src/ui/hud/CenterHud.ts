import { setAttr, setSvgTransform, setText, clamp, svg } from '../dom';
import type { HudTelemetry } from '../Telemetry';
import { VecStage, arcPath, tickRing } from './vec';

export interface LeadState {
  /** Screen position of the lead pip, in CSS pixels. */
  x: number;
  y: number;
  visible: boolean;
  /** Range to the tracked target, metres (0 = unknown). */
  range: number;
  /** True when the pip sits on the target — the gunsight goes hot. */
  onTarget: boolean;
  /** Time of flight to the target, seconds. */
  tof: number;
}

const DEG = Math.PI / 180;

/**
 * The centre of the HUD: gunsight, lead computer pip, pitch ladder, bank and
 * slip indicators, flight-path marker, hit marker and damage-direction arcs.
 *
 * The pitch ladder is *conformal*: each bar is placed at
 * 'y = f · tan(θ − θ_ac)' where 'f' is the focal length in pixels implied by
 * the camera's vertical FOV. That means the ladder's zero line lies exactly on
 * the real horizon and a 20° bar lies exactly on the 20° depression angle in
 * the rendered world, which is the whole point of a HUD and is what makes it
 * feel like an instrument rather than a decal.
 */
export class CenterHud {
  private stage: VecStage;
  private gRet: SVGGElement;
  private gPip: SVGGElement;
  private pipLit: SVGUseElement | undefined;
  private gLead: SVGGElement;
  private gLeadLink: SVGGElement;
  private gLadder: SVGGElement;
  private gLadderInner: SVGGElement;
  private gBank: SVGGElement;
  private gBankPtr: SVGGElement;
  private gSlip: SVGGElement;
  private gSlipBall: SVGGElement;
  private gFpm: SVGGElement;
  private gHit: SVGGElement;
  private gDmg: SVGGElement;

  private retTicks: SVGPathElement;
  private retRing1: SVGPathElement;
  private retRing2: SVGPathElement;
  private retDots: SVGPathElement;
  private retBracket: SVGPathElement;

  private leadRing: SVGCircleElement;
  private leadCross: SVGPathElement;
  private leadLine: SVGLineElement;

  private bars: { g: SVGGElement; deg: number; shown: boolean }[] = [];
  private horizon!: SVGPathElement;

  private fpmRing: SVGCircleElement;
  private fpmWings: SVGPathElement;

  private hitPath: SVGPathElement;
  private dmgArcs: { g: SVGGElement; life: number }[] = [];

  private w = 1920;
  private h = 1080;
  private u = 1;      // one design pixel, in CSS pixels
  private f = 900;    // focal length in CSS pixels
  private cx = 960;
  private cy = 540;

  private fpmX = 0;
  private fpmY = 0;
  private fpmOn = false;

  /** True while the camera is inside the cockpit. See 'setCockpit'. */
  private cockpit = false;
  private clipRect: SVGRectElement;
  private clipId: string;
  private ladderUses: SVGUseElement[] = [];

  constructor(parent: HTMLElement) {
    this.stage = new VecStage(parent, 'ct-center-svg');

    // --- ladder (drawn first so the gunsight sits on top) -----------------
    // The ladder is the one element that spends most of its life lying across
    // the brightest thing in the frame — a sunlit cumulus top. A 1.7 px white
    // stroke over that is invisible, so this layer asks for the heavy ink pass:
    // a wider, more opaque dark contour that gives every rung its own
    // silhouette regardless of what is behind it.
    this.gLadder = this.stage.layer('', undefined, 'is-heavy');
    this.gLadderInner = svg('g', undefined, this.gLadder);

    // Occluder for the ladder in cockpit view.
    //
    // A conformal pitch ladder is drawn at infinity, so in an external view it
    // may legitimately cross anything. Inside a cockpit it may not: the '10'
    // and '20' rungs were printing across the instrument panel, over the
    // gauges, below the canopy sill — a hundred-metre-away sky mark painted on
    // a surface eighty centimetres from the eye, which is the one thing a
    // conformal element must never do. The airframe has no depth in the HUD's
    // world, so the sill is described here instead: a rect clipping everything
    // below the coaming line, computed from the same focal length the ladder
    // is placed with so it stays correct when the FOV moves.
    this.clipId = `ct-ck-sill-${(Math.random() * 1e6) | 0}`;
    const clip = svg('clipPath', { id: this.clipId, clipPathUnits: 'userSpaceOnUse' },
      this.stage.definitions);
    this.clipRect = svg('rect', { x: 0, y: 0, width: 4096, height: 2160 }, clip);
    this.ladderUses = this.stage.uses(this.gLadder);

    this.gBank = this.stage.layer('is-dim');
    this.gBankPtr = svg('g', undefined, this.gBank);
    this.gSlip = svg('g', undefined, this.gBankPtr);
    this.gSlipBall = svg('g', undefined, this.gSlip);

    // The flight-path marker is deliberately demoted. It is a circle with side
    // arms, the pipper is a circle with four arms and a hub, and drawn at the
    // same weight and the same white the two are the same glyph twice — in the
    // captures the eye could not tell which of the two rings near the centre
    // was the aiming reference. Dim is the correct rank anyway: the FPM says
    // where the aeroplane is going, the pipper says where the bullets go, and
    // only one of those is what the player is looking for in a gunnery frame.
    this.gFpm = this.stage.layer('is-dim');
    this.fpmRing = svg('circle', { cx: 0, cy: 0, r: 8 }, this.gFpm);
    this.fpmWings = svg('path', { d: '' }, this.gFpm);

    // --- gunsight ---------------------------------------------------------
    // Hierarchy, brightest last: the rings and the convergence bracket are
    // structure, the pipper is the one thing the eye must land on.
    //
    // There are no numerals on the sight any more. The two stadiametric rings
    // used to be labelled "400" and "800" at 8.5 design px, on the horizontal at
    // 3 o'clock — which is precisely where a target sits when you are tracking
    // it, so the aiming reference and the aeroplane were drawn on top of each
    // other. Moving them off the horizontal only relocated the problem: at that
    // size the two-pass ink halo is wider than the counters of the glyphs, so
    // they render as three dark lozenges rather than as a number, and no size
    // that fixes that is small enough to stay tertiary. Range belongs to the
    // contact block, which states it once, legibly, next to the aeroplane it
    // refers to.
    this.gRet = this.stage.layer('ct-reticle');
    this.retRing2 = svg('path', { d: '' }, this.gRet);
    this.retRing1 = svg('path', { d: '' }, this.gRet);
    this.retBracket = svg('path', { d: '' }, this.gRet);

    // The pipper is its own layer so it — and only it — can go hot amber the
    // instant the lead solution is inside the target, and so it can be given a
    // heavier, whiter stroke than the sight furniture around it. That contrast
    // step is the hierarchy: everything else is structure at 55 % value, the
    // pipper is the one mark at 100 %.
    this.gPip = this.stage.layer('ct-pipper');
    this.pipLit = this.stage.lit(this.gPip);
    this.retTicks = svg('path', { d: '' }, this.gPip);
    this.retDots = svg('path', { d: '' }, this.gPip);

    // --- lead pip ---------------------------------------------------------
    this.gLeadLink = this.stage.layer('is-dim');
    this.leadLine = svg('line', { x1: 0, y1: 0, x2: 0, y2: 0, 'stroke-dasharray': '3 4' }, this.gLeadLink);

    // The lead pip carries no text. It used to print the range to the target
    // one glyph-height below itself, which is the same number the contact block
    // already prints, in the same colour, a few pixels away — two readings of
    // one fact fighting for the same space at the exact moment the player is
    // trying to see the aeroplane behind them.
    this.gLead = this.stage.layer('is-accent');
    this.leadRing = svg('circle', { cx: 0, cy: 0, r: 9 }, this.gLead);
    this.leadCross = svg('path', { d: '' }, this.gLead);

    // --- hit marker + damage direction -----------------------------------
    this.gHit = this.stage.layer('', 'ct-hitmark');
    this.hitPath = svg('path', { d: '' }, this.gHit);

    this.gDmg = this.stage.layer();
    for (let i = 0; i < 6; i++) {
      const g = svg('g', { class: 'ct-dmgdir' }, this.gDmg);
      svg('path', { d: '' }, g);
      this.dmgArcs.push({ g, life: 0 });
    }

    this.buildLadder();
  }

  // -------------------------------------------------------------------------

  private buildLadder(): void {
    // −90 … +90 in 5° steps. Built once; only the transform changes per frame.
    for (let d = -90; d <= 90; d += 5) {
      const g = svg('g', { display: 'none' }, this.gLadderInner);
      svg('path', { d: '' }, g);
      if (d !== 0) {
        svg('text', { class: 'ct-vtx', 'text-anchor': 'end' }, g);
        svg('text', { class: 'ct-vtx', 'text-anchor': 'start' }, g);
      }
      this.bars.push({ g, deg: d, shown: false });
    }
    this.horizon = svg('path', { d: '' }, this.gLadderInner);
  }

  /**
   * Updates the focal length only. The camera system is free to breathe the
   * FOV with speed or zoom; the ladder has to follow it every frame to stay
   * conformal, and rebuilding the geometry for that would be absurd.
   */
  setFov(fovDeg: number): void {
    this.f = (this.h * 0.5) / Math.tan(clamp(fovDeg, 20, 130) * 0.5 * DEG);
    if (this.cockpit) this.applySillClip();
  }

  /**
   * Puts the camera inside or outside the cockpit.
   *
   * Two things change. The ladder gets clipped at the coaming (see the clip
   * path built in the constructor), and the convergence bracket is dropped —
   * from the pilot's seat the reflector sight's own frame, hood and mounting
   * already draw a box round the aiming point, and adding four more corners on
   * top of it is how the cockpit ended up with seven marks stacked at one
   * place while the external HUD had three.
   */
  setCockpit(on: boolean): void {
    if (on === this.cockpit) return;
    this.cockpit = on;
    this.applySillClip();
    setAttr(this.retBracket, 'display', on ? 'none' : 'inline');
  }

  /**
   * Depression of the canopy sill below the boresight, degrees.
   *
   * Measured off the rendered cockpit rather than assumed: the coaming's top
   * edge sits 165 px below frame centre at 1080p on a 66 degree lens, and
   * atan(165 / 831) is 11.2. Expressing it as an angle rather than as a pixel
   * row is what keeps it right when the FOV breathes or the window resizes.
   */
  private applySillClip(): void {
    const yCut = this.cockpit
      ? Math.round(this.cy + this.f * Math.tan(11.2 * DEG))
      : 1e5;
    setAttr(this.clipRect, 'y', -1e4);
    setAttr(this.clipRect, 'x', -1e4);
    setAttr(this.clipRect, 'width', 1e5);
    setAttr(this.clipRect, 'height', yCut + 1e4);
    // 'none' rather than an empty attribute: an empty clip-path is invalid and
    // browsers disagree about whether that means "no clip" or "clip everything".
    for (const u of this.ladderUses) {
      setAttr(u, 'clip-path', this.cockpit ? `url(#${this.clipId})` : 'none');
    }
  }

  resize(w: number, h: number, u: number, fovDeg: number): void {
    this.w = w; this.h = h; this.u = u;
    this.cx = Math.round(w * 0.5);
    this.cy = Math.round(h * 0.5);
    this.f = (h * 0.5) / Math.tan(clamp(fovDeg, 20, 130) * 0.5 * DEG);

    const U = u;
    const t = (v: number) => (v * U).toFixed(1);

    /*
     * Gunsight.
     *
     * Rebuilt for hierarchy. The previous sight drew, concentrically and all in
     * the same weight: a 32 px broken ring, a 66 px broken ring, a 24-spoke
     * tick ring hanging off it, a 104 px convergence bracket and a four-arm
     * pipper — five rings of furniture with nothing brighter than anything
     * else, which is why the critique could not find the pipper. A gunsight has
     * exactly one job: say where the bullets go. So there is now one thing the
     * eye lands on and everything else is demoted:
     *
     *   - the pipper is a filled dot inside an open ring with four short arms,
     *     drawn last, in its own layer, and it is the only element that can go
     *     hot amber when the lead solution is inside the target;
     *   - ONE stadiametric ring survives, at 66, broken at the diagonals;
     *   - the tick ring is gone — 24 spokes of identical weight around the one
     *     place the player is looking is pure noise;
     *   - the convergence bracket keeps its four corners but is drawn dim and
     *     pulled out to 116 so it frames the sight instead of crowding it.
     */
    setSvgTransform(this.gRet, `translate(${this.cx},${this.cy})`);
    setSvgTransform(this.gPip, `translate(${this.cx},${this.cy})`);
    // Pipper: four short arms with a gap, a small open ring, and a filled hub.
    let d = '';
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const c = Math.cos(a), s = Math.sin(a);
      d += `M ${t(c * 11)} ${t(s * 11)} L ${t(c * 26)} ${t(s * 26)} `;
    }
    d += arcPath(7.5 * U, 0, Math.PI * 1.999) + ' ';
    setAttr(this.retTicks, 'd', d);
    // The hub is a stroked micro-circle rather than a filled shape: the two-pass
    // ink/lit rig sets fill:none and stroke-width from the stylesheet (CSS beats
    // a presentation attribute, so setting stroke-width here would be silently
    // ignored), and a 1.7 px stroke around a 1.7 px radius closes into a solid
    // disc. It is the single highest-contrast mark in the frame.
    setAttr(this.retDots, 'd', arcPath(1.7 * U, 0, Math.PI * 1.999));

    // Inner ring retired: two concentric broken rings plus a tick ring was the
    // "pile of circles". Kept as an empty path so the node count is stable.
    setAttr(this.retRing1, 'd', '');
    let r2 = '';
    for (let i = 0; i < 4; i++) {
      const a0 = i * Math.PI / 2 + 0.16, a1 = (i + 1) * Math.PI / 2 - 0.16;
      r2 += arcPath(66 * U, a0, a1) + ' ';
    }
    // Four index stubs on the diagonals, in the gaps the ring leaves — enough
    // to read the ring as a graduated instrument without 24 spokes of noise.
    r2 += tickRing(66 * U, 74 * U, 4, Math.PI / 4);
    setAttr(this.retRing2, 'd', r2);

    // Convergence bracket — where the guns' cones cross at harmonisation.
    const b = 116 * U, l = 20 * U;
    setAttr(this.retBracket, 'd',
      `M ${-b} ${-b + l} L ${-b} ${-b} L ${-b + l} ${-b} ` +
      `M ${b - l} ${-b} L ${b} ${-b} L ${b} ${-b + l} ` +
      `M ${b} ${b - l} L ${b} ${b} L ${b - l} ${b} ` +
      `M ${-b + l} ${b} L ${-b} ${b} L ${-b} ${b - l}`);

    // Lead pip -------------------------------------------------------------
    setAttr(this.leadRing, 'r', t(9));
    setAttr(this.leadCross, 'd',
      `M ${t(-15)} 0 L ${t(-11)} 0 M ${t(11)} 0 L ${t(15)} 0 ` +
      `M 0 ${t(-15)} L 0 ${t(-11)} M 0 ${t(11)} L 0 ${t(15)}`);

    // Flight-path marker ---------------------------------------------------
    setAttr(this.fpmRing, 'r', t(7));
    setAttr(this.fpmWings, 'd',
      `M ${t(-7)} 0 L ${t(-19)} 0 M ${t(7)} 0 L ${t(19)} 0 M 0 ${t(-7)} L 0 ${t(-15)}`);

    // Hit marker -----------------------------------------------------------
    setSvgTransform(this.gHit, `translate(${this.cx},${this.cy})`);
    let hd = '';
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2;
      const c = Math.cos(a), s = Math.sin(a);
      hd += `M ${t(c * 11)} ${t(s * 11)} L ${t(c * 24)} ${t(s * 24)} `;
    }
    setAttr(this.hitPath, 'd', hd);

    // Damage-direction arcs ------------------------------------------------
    setSvgTransform(this.gDmg, `translate(${this.cx},${this.cy})`);
    for (const a of this.dmgArcs) {
      const p = a.g.firstElementChild as SVGPathElement;
      setAttr(p, 'd', arcPath(150 * U, -0.24 - Math.PI / 2, 0.24 - Math.PI / 2));
      setAttr(p, 'stroke-width', t(7));
    }

    // Ladder ---------------------------------------------------------------
    // The centre gap has to clear the *sight*, not just the pipper. At 44 the
    // rungs and their figures ran straight through the 66 px range ring, which
    // is half of what made the middle of the frame read as a pile of
    // overlapping furniture — the ladder, the ring and the pipper were all
    // competing for the same two hundred pixels. 86 puts the inner end of every
    // rung outside the ring and its tick stubs.
    const gap = 86 * U;
    const arm5 = 34 * U;
    const arm10 = 62 * U;
    const tick = 11 * U;
    for (const bar of this.bars) {
      const p = bar.g.firstElementChild as SVGPathElement;
      const dd = Math.abs(bar.deg);
      const major = dd % 10 === 0;
      const arm = major ? arm10 : arm5;
      const dir = bar.deg >= 0 ? 1 : -1;   // ticks always point at the horizon
      if (bar.deg === 0) {
        setAttr(p, 'd', '');
      } else {
        setAttr(p, 'd',
          `M ${-gap - arm} ${dir * tick} L ${-gap - arm} 0 L ${-gap} 0 ` +
          `M ${gap} 0 L ${gap + arm} 0 L ${gap + arm} ${dir * tick}`);
        setAttr(p, 'stroke-dasharray', bar.deg < 0 ? `${(7 * U).toFixed(1)} ${(5 * U).toFixed(1)}` : 'none');
        const [tl, tr] = [bar.g.children[1] as SVGTextElement, bar.g.children[2] as SVGTextElement];
        if (tl && tr) {
          const show = major;
          setAttr(tl, 'x', (-gap - arm - 6 * U).toFixed(1));
          setAttr(tl, 'y', (4 * U).toFixed(1));
          setAttr(tr, 'x', (gap + arm + 6 * U).toFixed(1));
          setAttr(tr, 'y', (4 * U).toFixed(1));
          setAttr(tl, 'font-size', t(10));
          setAttr(tr, 'font-size', t(10));
          setText(tl, show ? String(dd) : '');
          setText(tr, show ? String(dd) : '');
        }
      }
    }
    // The horizon bar runs wider and carries end caps, so it reads as "the
    // world" rather than as another ladder rung.
    const hw = 330 * U;
    // The gap has to clear the gunsight, not just the ladder rungs, or the
    // horizon line saws straight through the reticle rings.
    const hgap = 132 * U;
    setAttr(this.horizon, 'd',
      `M ${-hw} 0 L ${-hgap} 0 M ${-hw} ${-7 * U} L ${-hw} ${7 * U} ` +
      `M ${hgap} 0 L ${hw} 0 M ${hw} ${-7 * U} L ${hw} ${7 * U}`);

    this.applySillClip();

    // Bank arc -------------------------------------------------------------
    while (this.gBank.firstChild) this.gBank.removeChild(this.gBank.firstChild);
    this.gBank.appendChild(this.gBankPtr);
    const R = 168 * U;
    const arcG = svg('g', undefined, this.gBank);
    // Scale ticks at ±10/20/30/45/60, plus a fixed zero index.
    let bd = '';
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const ang = (-90 + a) * DEG;
      const len = Math.abs(a) % 30 === 0 ? 11 * U : 6 * U;
      const c = Math.cos(ang), s = Math.sin(ang);
      bd += `M ${(c * R).toFixed(1)} ${(s * R).toFixed(1)} L ${(c * (R + len)).toFixed(1)} ${(s * (R + len)).toFixed(1)} `;
    }
    bd += arcPath(R, (-90 - 62) * DEG, (-90 + 62) * DEG);
    svg('path', { d: bd }, arcG);
    // Fixed zero index (a small inverted triangle above the arc).
    svg('path', {
      d: `M ${-6 * U} ${-R - 14 * U} L ${6 * U} ${-R - 14 * U} L 0 ${-R - 3 * U} Z`,
    }, arcG);

    // Rolling pointer + slip/skid ball.
    while (this.gBankPtr.firstChild) this.gBankPtr.removeChild(this.gBankPtr.firstChild);
    svg('path', {
      d: `M ${-7 * U} ${-R + 16 * U} L ${7 * U} ${-R + 16 * U} L 0 ${-R + 3 * U} Z`,
    }, this.gBankPtr);
    this.gBankPtr.appendChild(this.gSlip);
    while (this.gSlip.firstChild) this.gSlip.removeChild(this.gSlip.firstChild);
    const sy = -R + 20 * U, sw = 17 * U, sh = 11 * U;
    svg('path', {
      d: `M ${-sw} ${sy} L ${sw} ${sy} L ${sw} ${sy + sh} L ${-sw} ${sy + sh} Z ` +
         `M ${-5.5 * U} ${sy} L ${-5.5 * U} ${sy + sh} M ${5.5 * U} ${sy} M ${5.5 * U} ${sy} L ${5.5 * U} ${sy + sh}`,
    }, this.gSlip);
    this.gSlip.appendChild(this.gSlipBall);
    while (this.gSlipBall.firstChild) this.gSlipBall.removeChild(this.gSlipBall.firstChild);
    svg('circle', { cx: 0, cy: sy + sh * 0.5, r: 4 * U }, this.gSlipBall);
    setSvgTransform(this.gBank, `translate(${this.cx},${this.cy})`);
  }

  // -------------------------------------------------------------------------

  update(t: HudTelemetry, lead: LeadState, dt: number): void {
    const U = this.u;

    // --- ladder -----------------------------------------------------------
    setSvgTransform(this.gLadder, `translate(${this.cx},${this.cy}) rotate(${(-t.roll).toFixed(2)})`);
    const pitch = t.pitch;
    // Where the lead marker falls in the ladder's own rotated frame, so a rung
    // figure can stand aside for it. The ladder is drawn under
    // 'translate(cx,cy) rotate(-roll)'; undoing that is one rotation by -roll
    // of the screen-space offset. R5 asked for the reticle stack to be
    // untangled and hud.png delivered, but the '10' figure still printed
    // through the lead bracket, which is the last of the collisions.
    const lr = -t.roll * DEG;
    const ldx = lead.x - this.cx, ldy = lead.y - this.cy;
    const leadLx = ldx * Math.cos(lr) + ldy * Math.sin(lr);
    const leadLy = -ldx * Math.sin(lr) + ldy * Math.cos(lr);
    const leadOn = lead.visible;
    for (const bar of this.bars) {
      const rel = bar.deg - pitch;
      const show = Math.abs(rel) < 26;
      if (show !== bar.shown) {
        bar.shown = show;
        setAttr(bar.g, 'display', show ? 'inline' : 'none');
      }
      if (!show) continue;
      const y = -this.f * Math.tan(rel * DEG);
      setSvgTransform(bar.g, `translate(0,${y.toFixed(1)})`);
      if (bar.deg === 0) setSvgTransform(this.horizon, `translate(0,${y.toFixed(1)})`);
      // Blank a rung's figures while the lead marker is on top of them.
      const tl = bar.g.children[1] as SVGTextElement | undefined;
      const tr = bar.g.children[2] as SVGTextElement | undefined;
      if (tl && tr && Math.abs(bar.deg) % 10 === 0 && bar.deg !== 0) {
        const near = leadOn && Math.abs(leadLy - y) < 17 * U;
        const dd = String(Math.abs(bar.deg));
        setText(tl, near && leadLx < 0 ? '' : dd);
        setText(tr, near && leadLx > 0 ? '' : dd);
      }
    }
    // The horizon bar belongs to the 0° rung; keep it in sync even when the
    // rung itself is culled, so the world line never disappears mid-loop.
    const relH = -pitch;
    const yH = -this.f * Math.tan(clamp(relH, -80, 80) * DEG);
    setAttr(this.horizon, 'display', Math.abs(relH) < 60 ? 'inline' : 'none');
    setSvgTransform(this.horizon, `translate(0,${yH.toFixed(1)})`);

    // --- bank + slip ------------------------------------------------------
    setSvgTransform(this.gBankPtr, `rotate(${(-t.roll).toFixed(2)})`);
    setSvgTransform(this.gSlipBall, `translate(${(clamp(t.slip, -1, 1) * 11 * U).toFixed(1)},0)`);

    // --- flight-path marker ----------------------------------------------
    // Suppressed when it lands on the sight. The FPM is a ring with side arms
    // and the pipper is a ring with four arms and a hub: sitting on top of each
    // other they are one indecipherable knot of circles, and the critique
    // counted the overlap as a second candidate aiming point. It is also the
    // one moment the FPM has nothing to say — coincident with the boresight
    // means the aeroplane is going exactly where it is pointing, which the
    // pipper already tells you. 84 px is just outside the 66 px range ring and
    // its tick stubs.
    const fpmClear = Math.hypot(this.fpmX - this.cx, this.fpmY - this.cy) > 84 * U;
    const fpmShow = this.fpmOn && fpmClear;
    setAttr(this.gFpm, 'display', fpmShow ? 'inline' : 'none');
    if (fpmShow) setSvgTransform(this.gFpm, `translate(${this.fpmX.toFixed(1)},${this.fpmY.toFixed(1)})`);

    // --- lead pip ---------------------------------------------------------
    const showLead = lead.visible;
    setAttr(this.gLead, 'display', showLead ? 'inline' : 'none');
    setAttr(this.gLeadLink, 'display', showLead ? 'inline' : 'none');
    if (showLead) {
      setSvgTransform(this.gLead, `translate(${lead.x.toFixed(1)},${lead.y.toFixed(1)})`);
      setSvgTransform(this.gLeadLink, `translate(${this.cx},${this.cy})`);
      setAttr(this.leadLine, 'x2', (lead.x - this.cx).toFixed(1));
      setAttr(this.leadLine, 'y2', (lead.y - this.cy).toFixed(1));
    }
    if (this.pipLit) this.pipLit.classList.toggle('is-accent', lead.onTarget);

    // --- damage-direction arcs -------------------------------------------
    for (const a of this.dmgArcs) {
      if (a.life <= 0) continue;
      a.life -= dt;
      const k = clamp(a.life / 2.2, 0, 1);
      // Ease out with a slight pop at the start so a hit is impossible to miss.
      a.g.style.opacity = String(k < 0.85 ? k * 0.95 : 1);
      if (a.life <= 0) a.g.style.opacity = '0';
    }
  }

  setFpm(x: number, y: number, on: boolean): void {
    this.fpmX = x; this.fpmY = y; this.fpmOn = on;
  }

  /** Flashes the hit marker. */
  hit(kind: 'hit' | 'crit' | 'kill' | 'armour'): void {
    const col = kind === 'kill' ? '#ffffff' : kind === 'crit' ? '#ffb23a' : kind === 'armour' ? '#8fb6d6' : '#ffffff';
    this.hitPath.style.stroke = col;
    this.gHit.classList.remove('is-fire');
    // Force a reflow so the animation restarts on rapid consecutive hits.
    void this.gHit.getBoundingClientRect().width;
    this.gHit.classList.add('is-fire');
  }

  /** 'bearing' is the direction to the damage source, radians, 0 = nose. */
  damageFrom(bearing: number): void {
    let slot = this.dmgArcs[0];
    for (const a of this.dmgArcs) if (a.life < slot.life) slot = a;
    slot.life = 2.2;
    slot.g.style.opacity = '1';
    setSvgTransform(slot.g, `rotate(${(bearing / DEG).toFixed(1)})`);
    (slot.g.firstElementChild as SVGPathElement).style.stroke = '#ff4a38';
  }

  setVisible(v: boolean): void {
    this.stage.svg.style.display = v ? '' : 'none';
  }
}
