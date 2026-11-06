import type { Macro } from '../types';

export const MAX_MACROS = 12;
export const MACRO_NAME_LENGTH = 24;
export const MACRO_DIGITS_LENGTH = 80;
/** Time per key while typing into the dial field, and per DTMF digit on a call. A digit needs 230 ms (160 ms tone + 70 ms gap). */
export const TYPE_INTERVAL = 80;
export const DTMF_INTERVAL = 260;
/** A comma in a macro waits this long. */
export const PAUSE = 1000;

/** What a macro can hold: keypad characters, commas for pauses, and spaces, dashes, dots or brackets so a number can be written the usual way. */
export const cleanDigits = (value: string) => value.replace(/[^0-9*#+, ().-]/g, '').slice(0, MACRO_DIGITS_LENGTH);
/** The keys a macro presses, in order. ',' is a pause; formatting is dropped. */
export const macroSteps = (digits: string) => [...digits.replace(/[^0-9*#+,]/g, '')];
/** A macro is worth a button once it presses at least one key. */
export const playable = (macro: Macro) => macroSteps(macro.digits).some(key => key !== ',');
export const macroLabel = (macro: Macro) => macro.name.trim() || macro.digits.trim();
/** Saved macros, dropping anything malformed. */
export function cleanMacros(value: unknown): Macro[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is Macro => !!m && typeof m === 'object' && typeof m.id === 'string' && typeof m.name === 'string' && typeof m.digits === 'string')
    .slice(0, MAX_MACROS).map(m => ({ id: m.id, name: m.name.slice(0, MACRO_NAME_LENGTH), digits: cleanDigits(m.digits) }));
}

/** The macro playing now. `target` is the call it sends DTMF to, or '' for the dial field; `key` is the key held down at this moment. */
export type MacroRun = { id: string; target: string; done: number; total: number; key: string };

/**
 * Plays one macro at a time, pressing each key for most of an interval and releasing it for the rest, so the keypad can light
 * each key in turn. It lives outside the phone panel so a macro sending DTMF keeps going while another tab is open.
 * `press` returns false to stop early, for example when the call has ended.
 */
export class MacroPlayer {
  private run: MacroRun | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.run;
  private set(run: MacroRun | null) { this.run = run; for (const listener of this.listeners) listener(); }
  play(id: string, target: string, steps: string[], press: (key: string) => boolean | void, interval: number) {
    this.stop(); if (!steps.length) return;
    let done = 0; const run = { id, target, total: steps.length };
    const next = () => {
      if (done >= steps.length) { this.timer = undefined; this.set(null); return; }
      const key = steps[done++];
      if (key === ',') { this.set({ ...run, done, key: '' }); this.timer = setTimeout(next, PAUSE); return; }
      if (press(key) === false) { this.stop(); return; }
      this.set({ ...run, done, key });
      this.timer = setTimeout(() => { this.set({ ...run, done, key: '' }); this.timer = setTimeout(next, interval * .4); }, interval * .6);
    };
    next();
  }
  stop() { clearTimeout(this.timer); this.timer = undefined; if (this.run) this.set(null); }
}
export const macroPlayer = new MacroPlayer();
