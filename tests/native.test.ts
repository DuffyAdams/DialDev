import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { NativeSip, addressFor, validateAccount, decodeFrames, mixWav } = require('../electron/native-sip.cjs');
const account = { id: 'test-1', username: 'user', domain: 'sip.example.com', transport: 'tls', port: '5061', proxy: '', stun: '', mediaEncryption: 'srtp' };
describe('native IPC boundaries', () => {
  it('keeps passwords out of SIP account address strings', () => { const address = addressFor({ ...account, password: 'secret' }); expect(address).not.toContain('secret'); expect(address).toContain('transport=tls'); expect(address).toContain('mediaenc=srtp-mand'); });
  it('registers every 5 minutes, or not at all for outbound-only accounts', () => { expect(addressFor(account)).toContain(';regint=300;'); expect(addressFor({ ...account, outboundOnly: true })).toContain(';regint=0;'); });
  it('rejects account-file injection, invalid ports and transport downgrade', () => { for (const fields of [{ domain: 'pbx\nmodule evil.so' }, { proxy: 'sip:pbx>;auth_pass=evil' }, { port: '65536' }, { transport: 'ws' }, { id: '../secret' }]) expect(() => validateAccount({ ...account, ...fields })).toThrow(); });
  it('parses partial and coalesced netstrings with UTF-8 bodies', () => { const object = { body: 'Héllo' }; const body = Buffer.from(JSON.stringify(object)); const frame = Buffer.concat([Buffer.from(`${body.length}:`), body, Buffer.from(',')]); const received: unknown[] = []; let remaining = decodeFrames(frame.subarray(0, 8), (x: unknown) => received.push(x)); expect(received).toHaveLength(0); remaining = decodeFrames(Buffer.concat([remaining, frame.subarray(8), frame]), (x: unknown) => received.push(x)); expect(received).toEqual([object, object]); expect(remaining.length).toBe(0); });
  it('rejects malformed and oversized netstrings', () => { for (const frame of ['x:xx,', '99999999:', '2:{}!', '1234567890']) expect(() => decodeFrames(Buffer.from(frame), () => {})).toThrow(); });
  it('switches the engine to the chosen audio devices by name, or the default', async () => {
    const sip = new NativeSip({ binary: '', directory: '', emit: () => {} }); const sent: string[] = []; sip.socket = { destroyed: false }; sip.request = async (command: string, params: string) => { sent.push(`${command} ${params}`); };
    await sip.setDevices({ input: 'Yeti Stereo Microphone', output: '' });
    expect(sent).toEqual(process.platform === 'darwin' ? ['ausrc audiounit,Yeti Stereo Microphone', 'auplay audiounit,default'] : []);
  });
  it('rejects audio device names that could inject engine commands', async () => { const sip = new NativeSip({ binary: '', directory: '', emit: () => {} }); for (const input of ['Mic\n/quit', 'x'.repeat(121), 3]) await expect(sip.setDevices({ input, output: '' })).rejects.toThrow(); });
  it('rejects corrupted recordings before mixing', () => { expect(() => mixWav(Buffer.from('bad'), Buffer.from('bad'))).toThrow(); });
});
