import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', {});
const { parseSipInput, accountLabel } = await import('../src/lib/utils');
const { blankAccount, finishAccount } = await import('../src/components/AccountSheet');
const account = (fields: Record<string, string>) => ({ ...blankAccount(), transport: 'udp' as const, ...fields });
describe('account setup', () => {
  it('reads host, host:port, user@host and full SIP URIs', () => {
    expect(parseSipInput('pbx.example.com')).toEqual({ domain: 'pbx.example.com' });
    expect(parseSipInput('pbx.example.com:5080')).toEqual({ domain: 'pbx.example.com', port: '5080' });
    expect(parseSipInput('sip:1001@10.0.0.5:5062;transport=TCP')).toEqual({ username: '1001', domain: '10.0.0.5', port: '5062', transport: 'tcp' });
    expect(parseSipInput('sips:alice@secure.example')).toEqual({ username: 'alice', domain: 'secure.example', transport: 'tls' });
    expect(parseSipInput('[2001:db8::1]:5060')).toEqual({ domain: '[2001:db8::1]', port: '5060' });
    expect(parseSipInput('user%40corp@pbx.example')).toEqual({ username: 'user@corp', domain: 'pbx.example' });
    for (const bad of ['pbx example.com', 'https://pbx.example.com/path', 'user@%zz@host:']) expect(parseSipInput(bad)).toBeNull();
  });
  it('labels accounts by name, falling back to user@host', () => {
    expect(accountLabel({ name: '  ', username: '1001', domain: 'pbx' })).toBe('1001@pbx');
    expect(accountLabel({ name: 'Lab', username: '1001', domain: 'pbx' })).toBe('Lab');
  });
  it('normalises fields and fills defaults before saving', () => {
    const saved = finishAccount(account({ domain: ' pbx.example.com ', username: ' 1001 ', port: '', transport: 'tls', proxy: 'edge.example.com:5070', stun: 'stun.example.com' }));
    expect(saved).toMatchObject({ domain: 'pbx.example.com', username: '1001', port: '5061', proxy: 'sip:edge.example.com:5070', stun: 'stun:stun.example.com' });
    expect(finishAccount(account({ transport: 'wss', server: 'wss://rtc.example.com:8089/ws', username: 'web' })).domain).toBe('rtc.example.com');
  });
  it('rejects values the SIP engines would refuse', () => {
    for (const fields of [{ domain: '', username: '1001' }, { domain: 'sip:pbx.example', username: '1001' }, { domain: 'pbx', username: '1001', port: '70000' }, { domain: 'pbx', username: 'two words' }, { domain: 'pbx', username: '' }, { domain: 'pbx', username: '1001', proxy: 'sip:edge>evil' }, { transport: 'wss', server: 'ws://insecure', username: 'web' }])
      expect(() => finishAccount(account(fields))).toThrow();
  });
});
