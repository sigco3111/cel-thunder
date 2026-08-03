import { svg } from '../dom';
import { NATION_COLOR } from '../theme';

/**
 * Vector marks: the game emblem and the five national insignia.
 *
 * Drawn rather than imported — there are no binary assets in this project, and
 * a hand-built path stays crisp from a 16 px filter chip to a 400 px title.
 */

/** Squadron-patch style emblem: swept wings over a shield with a bolt. */
export function makeEmblem(parent: Element, cls = 'ct-emblem'): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 120 120', class: cls }, parent);

  // Outer ring
  svg('circle', {
    cx: 60, cy: 60, r: 55, fill: 'none',
    stroke: 'rgba(255,178,58,0.85)', 'stroke-width': 2.5,
  }, s);
  svg('circle', {
    cx: 60, cy: 60, r: 49, fill: 'rgba(7,11,17,0.72)',
    stroke: 'rgba(220,236,251,0.28)', 'stroke-width': 1,
  }, s);

  // Sweep marks around the ring — twelve, longer at the cardinals.
  let ticks = '';
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r0 = 49, r1 = i % 6 === 0 ? 42 : 46;
    ticks += `M ${(60 + Math.cos(a) * r0).toFixed(2)} ${(60 + Math.sin(a) * r0).toFixed(2)} ` +
             `L ${(60 + Math.cos(a) * r1).toFixed(2)} ${(60 + Math.sin(a) * r1).toFixed(2)} `;
  }
  svg('path', { d: ticks, stroke: 'rgba(220,236,251,0.35)', 'stroke-width': 1.2, fill: 'none' }, s);

  // Wings
  const wing = (sgn: number) =>
    `M ${60 + sgn * 8} 56 L ${60 + sgn * 46} 44 L ${60 + sgn * 40} 52 ` +
    `L ${60 + sgn * 20} 58 L ${60 + sgn * 34} 60 L ${60 + sgn * 12} 66 Z`;
  svg('path', { d: wing(1), fill: 'rgba(220,236,251,0.92)' }, s);
  svg('path', { d: wing(-1), fill: 'rgba(220,236,251,0.92)' }, s);

  // Lightning bolt through the hub
  svg('path', {
    d: 'M 63 34 L 52 60 L 60 60 L 55 88 L 70 58 L 61 58 Z',
    fill: '#ffb23a', stroke: 'rgba(7,11,17,0.85)', 'stroke-width': 1.4, 'stroke-linejoin': 'round',
  }, s);

  return s;
}

/** Nation roundel at any size; 'size' is the viewBox-independent CSS size. */
export function makeRoundel(parent: Element, nation: string, cls = ''): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 24 24', class: cls }, parent);
  const col = NATION_COLOR[nation] ?? '#8899aa';
  switch (nation) {
    case 'britain':
      svg('circle', { cx: 12, cy: 12, r: 11, fill: '#1e4fa0' }, s);
      svg('circle', { cx: 12, cy: 12, r: 7, fill: '#f2f4f7' }, s);
      svg('circle', { cx: 12, cy: 12, r: 3.4, fill: '#c8322b' }, s);
      break;
    case 'usa':
      svg('circle', { cx: 12, cy: 12, r: 11, fill: '#123a8c' }, s);
      svg('path', { d: star(12, 12, 8.4, 3.6, 5), fill: '#f2f4f7' }, s);
      break;
    case 'ussr':
      svg('circle', { cx: 12, cy: 12, r: 11, fill: '#f2f4f7', opacity: 0.15 }, s);
      svg('path', { d: star(12, 12, 11, 4.6, 5), fill: '#d33a2c', stroke: '#f2f4f7', 'stroke-width': 0.8 }, s);
      break;
    case 'germany':
      svg('path', {
        d: 'M 9.5 1.5 H 14.5 V 9.5 H 22.5 V 14.5 H 14.5 V 22.5 H 9.5 V 14.5 H 1.5 V 9.5 H 9.5 Z',
        fill: '#0d1117', stroke: '#f2f4f7', 'stroke-width': 1.4,
      }, s);
      break;
    case 'japan':
      svg('circle', { cx: 12, cy: 12, r: 11, fill: '#f2f4f7', opacity: 0.12 }, s);
      svg('circle', { cx: 12, cy: 12, r: 9, fill: '#d9433c' }, s);
      break;
    default:
      svg('circle', { cx: 12, cy: 12, r: 10, fill: col }, s);
  }
  return s;
}

function star(cx: number, cy: number, r1: number, r2: number, points: number): string {
  let d = '';
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? r1 : r2;
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
    d += `${i === 0 ? 'M' : 'L'} ${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)} `;
  }
  return d + 'Z';
}
