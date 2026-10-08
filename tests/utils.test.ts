import { describe, it, expect } from 'vitest';
import { dialTarget, duration, logLine, parseVCard, vCard } from '../src/lib/utils';
describe('provider dialing', () => {
  it('keeps extension, international, feature-code, and SIP targets intact', () => {
    expect(dialTarget('+1 (415) 555-0123', 'pbx.example:5061')).toBe('sip:+14155550123@pbx.example:5061');
    expect(dialTarget('*97', 'pbx.example')).toBe('sip:*97@pbx.example');
    expect(dialTarget('alice@other.example', 'pbx.example')).toBe('sip:alice@other.example');
    expect(dialTarget('sips:alice@other.example', 'pbx.example')).toBe('sips:alice@other.example');
    expect(dialTarget('tel:101', 'pbx.example')).toBe('sip:101@pbx.example');
  });
  it('rejects blank targets and header injection', () => { for (const value of ['', ' ', '123\r\nContact: <sip:bad@bad>', '<sip:bad@bad>']) expect(() => dialTarget(value, 'pbx.example')).toThrow(); });
});
describe('address book portability', () => {
  it('round-trips unicode, punctuation, backslashes, and newlines through vCard', () => { const contacts = [{ name: 'Chén, Alex; Jr.', number: '+14155550123', email: 'alex@example.com', company: 'Studio\\North\nDesign' }]; expect(parseVCard(vCard(contacts))).toEqual(contacts); });
  it('handles folded vCard properties and skips cards without a phone', () => { expect(parseVCard('BEGIN:VCARD\r\nFN:Long\r\n Name\r\nTEL;TYPE=CELL:101\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:No phone\r\nEND:VCARD')).toEqual([{ name: 'LongName', number: '101', email: '', company: '' }]); });
  it('does not permit new vCard properties from contact input', () => { expect(vCard([{ name: 'One\nTEL:evil', number: '123', email: '', company: '' }])).toContain('FN:One\\nTEL:evil\r\nTEL:123'); });
});
it('formats call timers without invalid negative values', () => { expect(duration(-1)).toBe('00:00'); expect(duration(125.8)).toBe('02:05'); });
describe('activity export', () => {
  it('writes who said or sent what, with the DTMF method', () => {
    const time = Date.UTC(2026, 9, 8, 17, 2, 11, 204);
    expect(logLine({ id: 1, time, level: 'info', text: 'For billing, press one.', kind: 'speech', side: 'remote', speaker: 'Acme IVR' }, 'Line 1')).toBe('2026-10-08T17:02:11.204Z  SPEECH   [Line 1]  Acme IVR: For billing, press one.');
    expect(logLine({ id: 2, time, level: 'info', text: 'Sent DTMF 1', kind: 'dtmf', side: 'local', speaker: 'You', detail: 'RFC 4733' }, 'Line 1')).toBe('2026-10-08T17:02:11.204Z  DTMF     [Line 1]  You: Sent DTMF 1 (RFC 4733)');
    expect(logLine({ id: 3, time, level: 'warning', text: 'Call closed · 486 Busy Here' }, 'Line 1')).toBe('2026-10-08T17:02:11.204Z  WARNING  [Line 1]  Call closed · 486 Busy Here');
  });
});
