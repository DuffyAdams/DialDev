import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { audioFrame, decodeLines, sanitize } = require('../electron/transcriber.cjs');
describe('transcription helper boundary', () => {
  it('frames PCM the way the native engine does', () => {
    const frame: Buffer = audioFrame(16000, 1, Buffer.from([1, 0, 255, 255]));
    expect(frame.toString('ascii', 0, 4)).toBe('DDA1'); expect(frame.readUInt32LE(4)).toBe(16000); expect(frame.readUInt16LE(8)).toBe(1); expect(frame.readUInt32LE(12)).toBe(4); expect(frame.length).toBe(20);
  });
  it('reads JSON lines split across chunks and skips foreign output', () => {
    const received: unknown[] = []; let rest = decodeLines(Buffer.from('{"type":"rea'), (m: unknown) => received.push(m));
    rest = decodeLines(Buffer.concat([rest, Buffer.from('dy"}\nnot json\n{"type":"end"}\n')]), (m: unknown) => received.push(m));
    expect(received).toEqual([{ type: 'ready' }, { type: 'end' }]); expect(rest.length).toBe(0);
  });
  it('passes on only well-formed, bounded results', () => {
    expect(sanitize({ type: 'text', side: 'remote', final: true, text: 'Hi', start: 1.4, end: 2, extra: 'x' })).toEqual({ type: 'text', side: 'remote', final: true, text: 'Hi', start: 1, end: 2 });
    expect(sanitize({ type: 'text', side: 'local', text: 'x'.repeat(9000) }).text).toHaveLength(4000);
    for (const bad of [{ type: 'text', side: 'both', text: 'x' }, { type: 'dtmf', side: 'remote', digit: '<script>' }, { type: 'exec' }, null, 'text']) expect(sanitize(bad)).toBeNull();
    expect(sanitize({ type: 'dtmf', side: 'remote', digit: '#', time: 5 })).toEqual({ type: 'dtmf', side: 'remote', digit: '#', time: 5 });
  });
});
