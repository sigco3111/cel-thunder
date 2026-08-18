/**
 * The UI's colour and motion language, in one place.
 *
 * Two consumers: the stylesheet (as CSS custom properties) and the imperative
 * canvas/SVG drawing code (as raw strings), so the minimap and the HUD gauges
 * can never drift away from the panels around them.
 *
 * Palette rationale — this is a cel/graphic-novel military HUD, so:
 *  - the "paper" is near-white with a cold blue cast, never pure white, which
 *    would clip against bright sky;
 *  - the "ink" is a blue-black, never #000, matching the outline colour the
 *    renderer uses for silhouettes (0x0b0f16);
 *  - one warm accent (amber) carries all *player agency* — selection, focus,
 *    the aircraft you fly, your own marker;
 *  - team colours are cyan/red, deliberately far apart in hue and value so
 *    they survive the aerial-perspective haze at long range.
 */

export const COLORS = {
  ink: '#070b11',
  inkSoft: 'rgba(7, 11, 17, 0.72)',
  paper: '#e6f1fb',
  hud: '#dcecfb',
  hudDim: 'rgba(220, 236, 251, 0.52)',
  hudFaint: 'rgba(220, 236, 251, 0.26)',

  accent: '#ffb23a',
  accentHot: '#ffd27a',
  accent2: '#54d8ff',

  ally: '#5ad4ff',
  allyDim: 'rgba(90, 212, 255, 0.55)',
  enemy: '#ff5f4d',
  enemyDim: 'rgba(255, 95, 77, 0.55)',
  neutral: '#c8d4e0',

  ok: '#79e6a6',
  warn: '#ffc247',
  danger: '#ff4a38',
  crit: '#ff2d1a',

  glass: 'rgba(8, 13, 20, 0.56)',
  glassDeep: 'rgba(6, 10, 16, 0.86)',
  line: 'rgba(158, 199, 230, 0.20)',
  lineStrong: 'rgba(178, 214, 240, 0.38)',

  water: '#1d3d5c',
  waterDeep: '#12293f',
  land1: '#3a5236',
  land2: '#4a6440',
  land3: '#5d7748',
  land4: '#7c8f55',
  rock: '#8b8672',
  snow: '#d9e2e6',
} as const;

/** Team → colour. Team 0 = Allies, 1 = Axis; relative to the local player. */
export function teamColor(entityTeam: number, localTeam: number): string {
  return entityTeam === localTeam ? COLORS.ally : COLORS.enemy;
}

/** Nation → roundel/flag accent, used by the hangar and scoreboard. */
export const NATION_COLOR: Record<string, string> = {
  britain: '#2f6fd0',
  usa: '#3b63c9',
  ussr: '#d33a2c',
  germany: '#5b6672',
  japan: '#d9433c',
};

export const NATION_LABEL: Record<string, string> = {
  britain: 'Great Britain',
  usa: 'United States',
  ussr: 'Soviet Union',
  germany: 'Germany',
  japan: 'Japan',
};

/**
 * Mirror of NATION_LABEL in Korean. Both tables are exported so other modules
 * can pick the right label by language without having to thread t() through
 * every render site. The Hungarian-physics-style update below mutates
 * NATION_LABEL / ROLE_LABEL in place once Korean is active, which lets the
 * existing call sites — NATION_LABEL[spec.nation] — Just Work.
 */
const NATION_LABEL_KO: Record<string, string> = {
  britain: '영국',
  usa: '미국',
  ussr: '소련',
  germany: '독일',
  japan: '일본',
};

export const ROLE_LABEL: Record<string, string> = {
  fighter: 'Fighter',
  interceptor: 'Interceptor',
  attacker: 'Attacker',
  'boom-and-zoom': 'Energy Fighter',
  turnfighter: 'Turn Fighter',
};

const ROLE_LABEL_KO: Record<string, string> = {
  fighter: '전투기',
  interceptor: '요격기',
  attacker: '공격기',
  'boom-and-zoom': '에너지 전투기',
  turnfighter: '선회 전투기',
};

/** Apply localisation to the live NATION_LABEL / ROLE_LABEL dictionaries. */
export function applyLocalizationToTheme(): void {
  const lang = (globalThis as unknown as { __currentLang?: string }).__currentLang;
  if (lang !== 'ko') return;
  for (const key of Object.keys(NATION_LABEL)) NATION_LABEL[key] = NATION_LABEL_KO[key];
  for (const key of Object.keys(ROLE_LABEL)) ROLE_LABEL[key] = ROLE_LABEL_KO[key];
}

/**
 * Maps a 0..1 "badness" value to the ok → warn → danger ramp used by every
 * temperature/quantity bar, so all of them read identically at a glance.
 */
export function gaugeState(t: number): 'is-ok' | 'is-warn' | 'is-danger' {
  return t >= 0.86 ? 'is-danger' : t >= 0.66 ? 'is-warn' : 'is-ok';
}

export function gaugeColor(t: number): string {
  return t >= 0.86 ? COLORS.danger : t >= 0.66 ? COLORS.warn : COLORS.ok;
}
