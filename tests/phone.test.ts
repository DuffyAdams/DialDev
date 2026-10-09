import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Call } from '../src/types';
vi.stubGlobal('window', {});
const { PhoneEngine, simulated } = await import('../src/lib/phone');
const { defaults } = await import('../src/lib/storage');
describe('call lifecycle', () => {
  beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
  it('cancels dialing without a ghost call or duplicate history', async () => { const engine = new PhoneEngine(); const history = vi.fn(); engine.onHistory = history; const id = await engine.dial('101', 'Test', '', true); await engine.end(id); await vi.advanceTimersByTimeAsync(2000); expect(engine.getSnapshot().calls).toEqual([]); expect(history).toHaveBeenCalledTimes(1); expect(history.mock.calls[0][0].duration).toBe(0); });
  it('holds the original call before connecting another, then merges and separates', async () => { const engine = new PhoneEngine(); const first = await engine.dial('101', 'One', '', true); await vi.advanceTimersByTimeAsync(1500); const second = await engine.dial('102', 'Two', '', true); expect(engine.getSnapshot().calls.find(c => c.id === first)?.state).toBe('held'); await vi.advanceTimersByTimeAsync(1500); await engine.merge(); expect(engine.getSnapshot().calls.every(c => c.conference && c.state === 'active')).toBe(true); await engine.mute(first); expect(engine.getSnapshot().calls.every(c => c.muted)).toBe(true); await engine.hold(second, true); expect(engine.getSnapshot().calls.some(c => c.conference)).toBe(false); });
  it('tracks a missed incoming call and clears its timeout after answering', async () => { const engine = new PhoneEngine(); const history = vi.fn(); engine.onHistory = history; engine.simulateIncoming(); await vi.advanceTimersByTimeAsync(30001); expect(history.mock.calls[0][0].direction).toBe('missed'); engine.simulateIncoming(); const id = engine.getSnapshot().calls[0].id; await engine.answer(id); await vi.advanceTimersByTimeAsync(31000); expect(engine.getSnapshot().calls[0].state).toBe('active'); await engine.end(id); expect(history.mock.calls[1][0].direction).toBe('incoming'); });
  it('plays the test line through call progress and its menu without an account', async () => { const engine = new PhoneEngine(); const history = vi.fn(); engine.onHistory = history; const id = await engine.dial('1234', 'DialDev Test Line', '', true); await vi.advanceTimersByTimeAsync(1000); expect(engine.getSnapshot().calls[0].progress).toBe('ringing'); await vi.advanceTimersByTimeAsync(1500); expect(engine.getSnapshot().calls[0].progress).toBe('early'); await vi.advanceTimersByTimeAsync(4000); expect(engine.getSnapshot().calls[0].state).toBe('active'); await engine.dtmf(id, '7'); await engine.dtmf(id, '1'); await vi.advanceTimersByTimeAsync(1000); const speech = engine.getSnapshot().log.filter(e => e.kind === 'speech' && e.callId === id).map(e => e.text); expect(speech).toContain('You have sent 7, 1.'); expect(speech).not.toContain('There is no option 7.'); await engine.dtmf(id, '2'); await vi.advanceTimersByTimeAsync(3000); expect(engine.getSnapshot().log.filter(e => e.kind === 'dtmf' && e.side === 'remote').map(e => e.digit)).toEqual(['4', '2', '#']); await engine.dtmf(id, '#'); await vi.advanceTimersByTimeAsync(3000); expect(engine.getSnapshot().calls).toEqual([]); expect(history.mock.calls[0][1]).toBe(true); });
  it('calls back from the test line when 9 is pressed', async () => { const engine = new PhoneEngine(); const id = await engine.dial('1234', 'DialDev Test Line', '', true); await vi.advanceTimersByTimeAsync(6000); await engine.dtmf(id, '9'); await vi.advanceTimersByTimeAsync(4000); expect(engine.getSnapshot().calls).toEqual([]); await vi.advanceTimersByTimeAsync(3000); const [call] = engine.getSnapshot().calls; expect(call).toMatchObject({ direction: 'incoming', state: 'ringing', number: '1234', demo: true }); await engine.answer(call.id); await vi.advanceTimersByTimeAsync(1000); expect(engine.getSnapshot().log.some(e => e.callId === call.id && e.text.includes('calling you back'))).toBe(true); });
  it('simulates the test line, and calls added while only simulated calls are up', () => { const demo = { demo: true } as Call, live = { demo: false } as Call; expect(simulated(' 1234 ', [])).toBe(true); expect(simulated('5555', [])).toBe(false); expect(simulated('5555', [demo])).toBe(true); expect(simulated('5555', [demo, live])).toBe(false); });
  it('does not simulate a call in live mode without a registered account', async () => { const engine = new PhoneEngine(); await expect(engine.dial('101', 'Test', 'missing', false)).rejects.toThrow('Register a SIP account'); expect(engine.getSnapshot().calls).toHaveLength(0); });
  it('enforces the concurrent call limit', async () => { const engine = new PhoneEngine(); for (let i = 0; i < 5; i++) { await engine.dial(String(i), 'Test', '', true); await vi.advanceTimersByTimeAsync(1500); } await expect(engine.dial('6', 'Test', '', true)).rejects.toThrow('five'); });
  it('records sent DTMF digits on the call and in the activity log', async () => { const engine = new PhoneEngine(); const id = await engine.dial('8000', 'IVR', '', true); await vi.advanceTimersByTimeAsync(1500); await engine.dtmf(id, '1'); await engine.dtmf(id, '#'); await engine.dtmf(id, 'x'); expect(engine.getSnapshot().calls[0].dtmf).toBe('1#'); expect(engine.getSnapshot().log.map(e => e.text)).toEqual(expect.arrayContaining(['Sent DTMF 1', 'Sent DTMF #'])); });
  it('records connected native calls with Record Calls on, including calls already up when it is turned on', async () => {
    let send: (event: Record<string, unknown>) => void = () => {}; const sipAction = vi.fn(async (_: Record<string, unknown>) => undefined);
    Object.assign(window, { desktop: { onSipEvent: (callback: typeof send) => { send = callback; return () => {}; }, setCallActive: () => {}, sipAction } });
    try {
      const engine = new PhoneEngine(); engine.preferences = { ...defaults.preferences, recordCalls: true };
      send({ kind: 'event', accountId: 'a1', id: 'c1', type: 'CALL_OUTGOING', direction: 'outgoing', peeruri: 'sip:1002@pbx.example' }); await vi.advanceTimersByTimeAsync(0);
      expect(sipAction).not.toHaveBeenCalled();
      send({ kind: 'event', accountId: 'a1', id: 'c1', type: 'CALL_ESTABLISHED' }); await vi.advanceTimersByTimeAsync(0);
      expect(sipAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'record', call: 'c1' })); expect(engine.getSnapshot().calls[0].recording).toBe(true);
      engine.preferences = { ...defaults.preferences, recordCalls: false }; sipAction.mockClear();
      send({ kind: 'event', accountId: 'a1', id: 'c2', type: 'CALL_OUTGOING', direction: 'outgoing', peeruri: 'sip:1003@pbx.example' }); send({ kind: 'event', accountId: 'a1', id: 'c2', type: 'CALL_ESTABLISHED' }); await vi.advanceTimersByTimeAsync(0);
      const demo = await engine.dial('101', 'Test', '', true); await vi.advanceTimersByTimeAsync(1500);
      const records = () => sipAction.mock.calls.filter(([a]) => a.action === 'record').map(([a]) => a.call);
      expect(records()).toEqual([]);
      engine.preferences = { ...defaults.preferences, recordCalls: true }; await vi.advanceTimersByTimeAsync(0);
      expect(records()).toEqual(['c2']);
      expect(engine.getSnapshot().calls.find(c => c.id === demo)?.recording).toBe(false); expect(engine.getSnapshot().error).toBeNull();
    } finally { delete (window as { desktop?: unknown }).desktop; }
  });
  it('carries native call progress and the SIP close reason into history and the log', async () => {
    let send: (event: Record<string, unknown>) => void = () => {};
    Object.assign(window, { desktop: { onSipEvent: (callback: typeof send) => { send = callback; return () => {}; }, setCallActive: () => {} } });
    try {
      const engine = new PhoneEngine(); const history = vi.fn(); engine.onHistory = history;
      send({ kind: 'event', accountId: 'a1', id: 'c1', type: 'CALL_OUTGOING', direction: 'outgoing', peeruri: 'sip:1002@pbx.example' }); await vi.advanceTimersByTimeAsync(0);
      send({ kind: 'event', accountId: 'a1', id: 'c1', type: 'CALL_RINGING' }); await vi.advanceTimersByTimeAsync(0);
      expect(engine.getSnapshot().calls[0]).toMatchObject({ id: 'native:c1', progress: 'ringing', uri: 'sip:1002@pbx.example' });
      send({ kind: 'event', accountId: 'a1', id: 'c1', type: 'CALL_CLOSED', param: '486 Busy Here' }); await vi.advanceTimersByTimeAsync(0);
      expect(engine.getSnapshot().calls).toHaveLength(0);
      expect(history.mock.calls[0][0]).toMatchObject({ direction: 'outgoing', duration: 0, reason: '486 Busy Here', accountId: 'a1' });
      expect(engine.getSnapshot().log.at(-1)).toMatchObject({ level: 'warning', text: 'Call closed · 486 Busy Here', accountId: 'a1' });
      expect(engine.getSnapshot().error).toBeNull();
    } finally { delete (window as { desktop?: unknown }).desktop; }
  });
  it('logs registration changes once and keeps the log bounded', () => { const engine = new PhoneEngine(); const connection = (engine as unknown as { connection: (id: string, state: string, detail?: string) => void }).connection.bind(engine); connection('a1', 'registered'); connection('a1', 'registered'); connection('a1', 'error', '403 Forbidden'); expect(engine.getSnapshot().log.map(e => e.text)).toEqual(['Registered', 'Registration failed: 403 Forbidden']); for (let i = 0; i < 2100; i++) engine.log('info', String(i)); expect(engine.getSnapshot().log).toHaveLength(2000); expect(engine.getSnapshot().log.at(-1)?.text).toBe('2099'); });
  it('blocks recording for demo calls', async () => { const engine = new PhoneEngine(); const id = await engine.dial('101', 'Test', '', true); await vi.advanceTimersByTimeAsync(1500); await expect(engine.record(id)).rejects.toThrow('live call'); });
  describe('live transcription', () => {
    type Send = (event: Record<string, unknown>) => void;
    const desktop = (available = true) => { const bridge = { send: (() => {}) as Send, started: vi.fn(async () => {}), stopped: vi.fn(async () => {}) }; Object.assign(window, { desktop: { onSipEvent: (callback: Send) => { bridge.send = callback; return () => {}; }, setCallActive: () => {}, transcriptionInfo: async () => ({ available, reason: 'Live transcription requires macOS 26 or later.', locales: [] }), transcribeStart: bridge.started, transcribeStop: bridge.stopped } }); return bridge; };
    afterEach(() => { delete (window as { desktop?: unknown }).desktop; });
    it('places speech, DTMF and live partial results on one timeline', async () => {
      const bridge = desktop(); const engine = new PhoneEngine(); const t0 = Date.now();
      const say = (transcript: Record<string, unknown>) => bridge.send({ kind: 'transcript', call: 'native:c1', transcript });
      bridge.send({ kind: 'event', accountId: 'a1', id: 'c1', type: 'CALL_OUTGOING', direction: 'outgoing', peeruri: 'sip:8000@pbx.example' }); await vi.advanceTimersByTimeAsync(0);
      expect(bridge.started).toHaveBeenCalledWith('native:c1', ''); expect(engine.getSnapshot().calls[0].transcribing).toBe(true);
      say({ type: 'text', side: 'remote', final: false, text: 'For billing', start: t0 - 3000 });
      const partial = engine.getSnapshot().log.find(e => e.partial)!;
      say({ type: 'text', side: 'remote', final: false, text: 'For billing, press', start: t0 - 3000 });
      expect(engine.getSnapshot().log.filter(e => e.partial)).toEqual([expect.objectContaining({ id: partial.id, kind: 'speech', side: 'remote', speaker: '8000', text: 'For billing, press' })]);
      bridge.send({ kind: 'event', accountId: 'a1', id: 'c1', type: 'CALL_DTMF_START', param: '1' });
      say({ type: 'text', side: 'remote', final: true, text: 'For billing, press one.', start: t0 - 3000, end: t0 - 1000 });
      say({ type: 'dtmf', side: 'remote', digit: '5', time: t0 - 500 });
      await engine.dtmf('native:c1', '9').catch(() => {});
      const conversation = engine.getSnapshot().log.filter(e => e.kind);
      expect(conversation.map(e => `${e.speaker}|${e.text}|${e.detail || ''}`)).toEqual(['8000|For billing, press one.|', '8000|Heard DTMF 5|in-band tone', '8000|Received DTMF 1|out-of-band', 'You|Sent DTMF 9|RFC 4733']);
      expect(engine.getSnapshot().log.some(e => e.partial)).toBe(false);
      say({ type: 'text', side: 'local', final: false, text: 'Hello', start: t0 });
      bridge.send({ kind: 'event', accountId: 'a1', id: 'c1', type: 'CALL_CLOSED', param: 'Normal' }); await vi.advanceTimersByTimeAsync(0);
      expect(bridge.stopped).toHaveBeenCalledWith('native:c1');
      say({ type: 'text', side: 'local', final: true, text: 'Hello there.', start: t0 });
      expect(engine.getSnapshot().log.filter(e => e.kind === 'speech').map(e => e.text)).toEqual(['For billing, press one.', 'Hello there.']);
      say({ type: 'text', side: 'local', final: false, text: 'Bye', start: t0 + 10 }); say({ type: 'end' });
      expect(engine.getSnapshot().log.some(e => e.partial)).toBe(false);
      say({ type: 'text', side: 'remote', final: true, text: 'Ignored after the session ends', start: t0 });
      expect(engine.getSnapshot().log.some(e => e.text.startsWith('Ignored'))).toBe(false);
    });
    it('stops when turned off during a call, and starts again when turned back on', async () => {
      const bridge = desktop(); const engine = new PhoneEngine();
      bridge.send({ kind: 'event', accountId: 'a1', id: 'c1', type: 'CALL_OUTGOING', direction: 'outgoing', peeruri: 'sip:8000@pbx.example' }); await vi.advanceTimersByTimeAsync(0);
      engine.preferences = { ...engine.preferences, transcribe: false };
      expect(bridge.stopped).toHaveBeenCalledWith('native:c1'); expect(engine.getSnapshot().calls[0].transcribing).toBe(false);
      bridge.send({ kind: 'transcript', call: 'native:c1', transcript: { type: 'end' } });
      engine.preferences = { ...engine.preferences, transcribe: true }; await vi.advanceTimersByTimeAsync(0);
      expect(bridge.started).toHaveBeenCalledTimes(2); expect(engine.getSnapshot().calls[0].transcribing).toBe(true);
    });
    it('leaves speaker echo out of what you said, whichever side is transcribed first', async () => {
      const bridge = desktop(); const engine = new PhoneEngine(); const t0 = Date.now();
      const say = (transcript: Record<string, unknown>) => bridge.send({ kind: 'transcript', call: 'native:c1', transcript });
      bridge.send({ kind: 'event', accountId: 'a1', id: 'c1', type: 'CALL_OUTGOING', direction: 'outgoing', peeruri: 'sip:8000@pbx.example' }); await vi.advanceTimersByTimeAsync(0);
      say({ type: 'text', side: 'remote', final: true, text: 'For billing, press one.', start: t0 - 2000 });
      say({ type: 'text', side: 'local', final: false, text: 'For billing press', start: t0 - 1900 });
      say({ type: 'text', side: 'local', final: true, text: 'for billing, press one', start: t0 - 1900 });
      say({ type: 'text', side: 'local', final: true, text: 'I need my billing statement please.', start: t0 });
      say({ type: 'text', side: 'local', final: true, text: 'Your call is important to us.', start: t0 + 1000 });
      say({ type: 'text', side: 'remote', final: true, text: 'Your call is important to us.', start: t0 + 900 });
      expect(engine.getSnapshot().log.filter(e => e.kind === 'speech').map(e => `${e.side}: ${e.text}`)).toEqual(['remote: For billing, press one.', 'local: I need my billing statement please.', 'remote: Your call is important to us.']);
      expect(engine.getSnapshot().log.some(e => e.partial)).toBe(false);
    });
    it('stays quiet where transcription is unavailable', async () => {
      const bridge = desktop(false); const engine = new PhoneEngine();
      bridge.send({ kind: 'event', accountId: 'a1', id: 'c1', type: 'CALL_OUTGOING', direction: 'outgoing', peeruri: 'sip:8000@pbx.example' }); await vi.advanceTimersByTimeAsync(0);
      expect(bridge.started).not.toHaveBeenCalled(); expect(engine.getSnapshot().log.some(e => e.level === 'warning')).toBe(false);
    });
  });
});
