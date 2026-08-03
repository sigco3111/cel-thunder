import { el, setText, setClass, setStyle, clamp } from '../dom';

/**
 * Form controls, rebuilt from scratch.
 *
 * Native range inputs and checkboxes carry the browser's own look, which is
 * the fastest way to make a game UI feel like a settings dialog from 2004. The
 * native input is kept underneath for keyboard access and accessibility, but
 * it is transparent and the visuals are ours.
 */

export interface RowOpts {
  desc?: string;
}

export function settingRow(parent: HTMLElement, label: string, opts: RowOpts = {}): HTMLElement {
  const row = el('div', 'ct-row', parent);
  const left = el('div', '', row);
  el('div', 'ct-row-name', left, label);
  if (opts.desc) el('div', 'ct-row-desc', left, opts.desc);
  return el('div', 'ct-row-ctl', row);
}

export function slider(
  parent: HTMLElement, min: number, max: number, step: number, value: number,
  format: (v: number) => string, onChange: (v: number) => void,
  ticks: number[] = [],
): { set: (v: number) => void } {
  const box = el('div', 'ct-slider', parent);
  el('div', 'trk', box);
  const fil = el('div', 'fil', box);
  const kn = el('div', 'kn', box);
  for (const t of ticks) {
    const tk = el('i', 'tick', box);
    tk.style.left = `${((t - min) / (max - min)) * 100}%`;
  }
  const input = el('input', '', box) as HTMLInputElement;
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(value);
  const num = el('span', 'ct-num', parent, format(value));

  const paint = (v: number) => {
    const f = (clamp(v, min, max) - min) / (max - min);
    setStyle(fil, 'width', `${f * 100}%`);
    setStyle(kn, 'left', `${f * 100}%`);
    setText(num, format(v));
  };
  paint(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    onChange(v);
  });
  return {
    set: (v: number) => { input.value = String(v); paint(v); },
  };
}

export function toggle(
  parent: HTMLElement, value: boolean, onChange: (v: boolean) => void,
): { set: (v: boolean) => void } {
  const box = el('button', 'ct-toggle', parent);
  el('span', 'kn', box);
  const lbl = el('span', 'lbl', box, value ? 'ON' : 'OFF');
  const paint = (v: boolean) => {
    setClass(box, 'is-on', v);
    setText(lbl, v ? 'ON' : 'OFF');
  };
  paint(value);
  let v = value;
  box.addEventListener('click', () => { v = !v; paint(v); onChange(v); });
  return { set: (nv: boolean) => { v = nv; paint(nv); } };
}

export function segmented<T extends string>(
  parent: HTMLElement, options: [T, string][], value: T, onChange: (v: T) => void,
): { set: (v: T) => void } {
  const box = el('div', 'ct-seg', parent);
  const btns = new Map<T, HTMLElement>();
  const paint = (v: T) => { for (const [k, b] of btns) setClass(b, 'is-on', k === v); };
  for (const [k, label] of options) {
    const b = el('button', '', box, label);
    b.addEventListener('click', () => { paint(k); onChange(k); });
    btns.set(k, b);
  }
  paint(value);
  return { set: paint };
}

export function textField(
  parent: HTMLElement, value: string, placeholder: string, onChange: (v: string) => void,
): HTMLInputElement {
  const input = el('input', 'ct-input', parent) as HTMLInputElement;
  input.value = value;
  input.placeholder = placeholder;
  input.maxLength = 20;
  input.addEventListener('input', () => onChange(input.value));
  input.addEventListener('keydown', (e) => e.stopPropagation());
  return input;
}

export function groupTitle(parent: HTMLElement, text: string): HTMLElement {
  return el('div', 'ct-group-title', parent, text);
}
