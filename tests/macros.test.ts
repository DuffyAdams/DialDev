import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MACROS, MacroPlayer, PAUSE, cleanDigits, cleanMacros, macroLabel, macroSteps, playable } from '../src/lib/macros';

describe('macro digits', () => {
  it('keeps keypad characters, pauses and number formatting, and drops everything else', () => {
    expect(cleanDigits('+1 (555) 123-4567')).toBe('+1 (555) 123-4567');
    expect(cleanDigits('1-800-FLOWERS')).toBe('1-800-');
    expect(cleanDigits('8000,,1234#*')).toBe('8000,,1234#*');
    expect(cleanDigits('9'.repeat(200))).toHaveLength(80);
  });
  it('presses only keys and pauses, in order', () => {
    expect(macroSteps('+1 (555) 123-4567')).toEqual([...'+15551234567']);
    expect(macroSteps('1,,2#')).toEqual(['1', ',', ',', '2', '#']);
  });
  it('needs at least one key to be worth a button, and falls back to its digits for a label', () => {
    expect(playable({ id: 'a', name: 'Wait', digits: ',,' })).toBe(false);
    expect(playable({ id: 'a', name: '', digits: ' ( ) ' })).toBe(false);
    expect(playable({ id: 'a', name: '', digits: '*97' })).toBe(true);
    expect(macroLabel({ id: 'a', name: '  ', digits: ' *97 ' })).toBe('*97');
    expect(macroLabel({ id: 'a', name: ' Voicemail ', digits: '*97' })).toBe('Voicemail');
  });
  it('drops malformed saved macros and limits the rest', () => {
    expect(cleanMacros('bad')).toEqual([]);
    expect(cleanMacros([null, { id: 1, name: 'x', digits: '1' }, { id: 'a', name: 'Cell', digits: '555 123abc' }, { id: 'b', name: 'n'.repeat(40), digits: '2', extra: true }]))
      .toEqual([{ id: 'a', name: 'Cell', digits: '555 123' }, { id: 'b', name: 'n'.repeat(24), digits: '2' }]);
    expect(cleanMacros(Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: '', digits: '1' })))).toHaveLength(MAX_MACROS);
  });
});

describe('macro player', () => {
  beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
  it('presses each key in turn, holds it for most of the interval, and waits at a comma', () => {
    const player = new MacroPlayer(); const press = vi.fn(); const changed = vi.fn(); player.subscribe(changed);
    player.play('m', 'call-1', macroSteps('12,#'), press, 100);
    expect(press.mock.calls.map(c => c[0])).toEqual(['1']);
    expect(player.getSnapshot()).toEqual({ id: 'm', target: 'call-1', done: 1, total: 4, key: '1' });
    vi.advanceTimersByTime(60); expect(player.getSnapshot()?.key).toBe('');
    vi.advanceTimersByTime(40); expect(press.mock.calls.map(c => c[0])).toEqual(['1', '2']);
    vi.advanceTimersByTime(100); expect(player.getSnapshot()).toMatchObject({ done: 3, key: '' });
    vi.advanceTimersByTime(PAUSE - 1); expect(press).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1); expect(press.mock.calls.map(c => c[0])).toEqual(['1', '2', '#']);
    vi.advanceTimersByTime(100); expect(player.getSnapshot()).toBeNull();
    expect(changed).toHaveBeenCalled();
  });
  it('stops on request, when a key cannot be pressed, and when another macro starts', () => {
    const player = new MacroPlayer(); const press = vi.fn();
    player.play('m', '', [...'123'], press, 100); player.stop();
    vi.advanceTimersByTime(1000); expect(press).toHaveBeenCalledTimes(1); expect(player.getSnapshot()).toBeNull();

    const refuse = vi.fn((key: string) => key !== '2');
    player.play('m', 'call-1', [...'123'], refuse, 100); vi.advanceTimersByTime(1000);
    expect(refuse.mock.calls.map(c => c[0])).toEqual(['1', '2']); expect(player.getSnapshot()).toBeNull();

    const first = vi.fn(); const second = vi.fn();
    player.play('a', '', [...'111'], first, 100); player.play('b', '', [...'22'], second, 100); vi.advanceTimersByTime(1000);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(2);
  });
  it('does nothing for an empty macro', () => { const player = new MacroPlayer(); const press = vi.fn(); player.play('m', '', [], press, 100); expect(player.getSnapshot()).toBeNull(); expect(press).not.toHaveBeenCalled(); });
});
