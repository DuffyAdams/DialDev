import { useEffect, useState } from 'react';
import { ChevronRight, Eye, EyeOff } from 'lucide-react';
import type { Account, Credentials, Transport } from '../types';
import { getSecret } from '../lib/storage';
import { defaultPort, errorText, parseSipInput, uid } from '../lib/utils';
import { IconButton, Segmented, Sheet, ToggleRow } from './UI';

export const blankAccount = (): Account => ({ id: uid(), name: '', username: '', domain: '', server: '', authUser: '', displayName: '', voicemail: '', stun: '', turn: '', turnUser: '', enabled: true, transport: window.desktop ? 'udp' : 'wss', port: '5060', proxy: '', mediaEncryption: 'none' });
const hostPattern = /^(?:[a-zA-Z0-9.-]+|\[[a-fA-F\d:]+\])$/;
const transports: { value: Transport; label: string; disabled?: boolean }[] = [{ value: 'udp', label: 'UDP', disabled: !window.desktop }, { value: 'tcp', label: 'TCP', disabled: !window.desktop }, { value: 'tls', label: 'TLS', disabled: !window.desktop }, { value: 'wss', label: 'WSS' }];

/** Validates and normalises the form into an account the engines accept. */
export function finishAccount(draft: Account): Account {
  const a = { ...draft, name: draft.name.trim(), username: draft.username.trim(), domain: draft.domain.trim(), port: draft.port.trim(), server: draft.server.trim(), authUser: draft.authUser.trim(), displayName: draft.displayName.trim(), voicemail: draft.voicemail.trim(), proxy: draft.proxy.trim(), stun: draft.stun.trim(), turn: draft.turn.trim(), turnUser: draft.turnUser.trim() };
  if (a.transport === 'wss') {
    if (!/^wss:\/\/[^\s/]+/i.test(a.server)) throw new Error('Enter the WebSocket URL, for example wss://pbx.example.com:8089/ws.');
    if (!a.domain) a.domain = new URL(a.server).hostname;
  }
  if (!a.domain) throw new Error('Enter the SIP server hostname or IP address.');
  if (!hostPattern.test(a.domain)) throw new Error('The SIP server should be a hostname or IP address, such as pbx.example.com or 10.0.0.5.');
  if (a.transport !== 'wss') { if (!a.port) a.port = defaultPort(a.transport); if (!/^\d{1,5}$/.test(a.port) || +a.port < 1 || +a.port > 65535) throw new Error('The port must be a number from 1 to 65535.'); }
  if (!a.username) throw new Error('Enter the username or extension.');
  if (/\s/.test(a.username) || a.username.length > 256) throw new Error('The username cannot contain spaces.');
  if (a.proxy && !/^sips?:/i.test(a.proxy)) a.proxy = `sip:${a.proxy}`;
  if (a.proxy && !/^sips?:[a-zA-Z0-9_.:@;=+[\]-]+$/.test(a.proxy)) throw new Error('Enter the outbound proxy as a host, host:port or SIP URI.');
  if (a.stun && !/^stuns?:/i.test(a.stun)) a.stun = `stun:${a.stun}`;
  if (a.turn && !/^turns?:/i.test(a.turn)) a.turn = `turn:${a.turn}`;
  return a;
}

type Props = { initial: Account; mode: 'new' | 'edit' | 'duplicate'; secretFrom?: string; onSave: (account: Account, secret: Credentials, remember: boolean) => Promise<void>; onClose: () => void };
export default function AccountSheet({ initial, mode, secretFrom, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(initial); const [secret, setSecret] = useState<Credentials>({ password: '', turnPassword: '' });
  const [remember, setRemember] = useState(!!window.desktop); const [reveal, setReveal] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState(() => !!(initial.authUser || initial.displayName || initial.proxy || initial.stun || initial.turn || initial.voicemail || initial.outboundOnly || initial.mediaEncryption !== 'none'));
  useEffect(() => { if (secretFrom) void getSecret(secretFrom).then(stored => { if (stored) setSecret(stored); }).catch(e => setError(errorText(e))); }, [secretFrom]);
  const set = <K extends keyof Account>(key: K, value: Account[K]) => setDraft(d => ({ ...d, [key]: value }));
  const transport = (value: Transport) => setDraft(d => ({ ...d, transport: value, port: !d.port || d.port === defaultPort(d.transport) ? defaultPort(value) : d.port }));
  // Accept host:port, user@host or a full SIP URI in the server field and spread it across the form.
  const absorb = (text: string) => {
    const parsed = parseSipInput(text); if (!parsed) return false;
    setDraft(d => { const t = parsed.transport ?? d.transport; return { ...d, domain: parsed.domain ?? d.domain, username: parsed.username ?? d.username, transport: t, port: parsed.port ?? (t !== d.transport && d.port === defaultPort(d.transport) ? defaultPort(t) : d.port) }; });
    return true;
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    try { const account = finishAccount(draft); setDraft(account); setBusy(true); await onSave(account, secret, remember); onClose(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const wss = draft.transport === 'wss';
  return <Sheet title={mode === 'edit' ? 'Edit Account' : 'New Account'} width={470} onClose={onClose}>
    <form className="account-form" onSubmit={submit} noValidate>
      <div className="form-group">
        <label className="form-row"><span className="row-label">SIP Server</span>
          <input autoFocus value={draft.domain} placeholder={wss ? 'Optional · from URL' : 'pbx.example.com'} spellCheck={false} autoCapitalize="off" autoComplete="off"
            onChange={e => set('domain', e.target.value)} onPaste={e => { const text = e.clipboardData.getData('text').trim(); if (/[@;]|^sips?:/i.test(text) && absorb(text)) e.preventDefault(); }}
            onBlur={e => { if (/[@:;]/.test(e.target.value) && !/^\[[^\]]*\]$/.test(e.target.value)) absorb(e.target.value); }} />
        </label>
        <div className="form-row"><span className="row-label">Transport</span><Segmented label="Transport" value={draft.transport} options={transports} onChange={transport} /></div>
        {!wss && <label className="form-row"><span className="row-label">Port</span><input className="port" inputMode="numeric" value={draft.port} placeholder={defaultPort(draft.transport)} onChange={e => set('port', e.target.value.replace(/\D/g, '').slice(0, 5))} /></label>}
        {wss && <label className="form-row"><span className="row-label">WebSocket URL</span><input value={draft.server} placeholder="wss://pbx.example.com:8089/ws" spellCheck={false} autoComplete="off" onChange={e => set('server', e.target.value)} /></label>}
      </div>
      <div className="form-group">
        <label className="form-row"><span className="row-label">Username</span><input value={draft.username} placeholder="1001" spellCheck={false} autoCapitalize="off" autoComplete="off" onChange={e => set('username', e.target.value)} /></label>
        <label className="form-row"><span className="row-label">Password</span><span className="password-field"><input type={reveal ? 'text' : 'password'} value={secret.password} placeholder="Optional" autoComplete="new-password" onChange={e => setSecret(s => ({ ...s, password: e.target.value }))} /><IconButton icon={reveal ? EyeOff : Eye} label={reveal ? 'Hide password' : 'Show password'} size={14} onClick={() => setReveal(!reveal)} /></span></label>
      </div>
      <div className="form-group">
        <label className="form-row"><span className="row-label">Label</span><input value={draft.name} placeholder={`${draft.username.trim() || 'user'}@${draft.domain.trim() || 'host'}`} onChange={e => set('name', e.target.value)} /></label>
      </div>
      <button type="button" className="disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><ChevronRight size={13} strokeWidth={2.2} />Advanced</button>
      {advanced && <>
        <div className="form-group">
          <label className="form-row"><span className="row-label">Auth Username</span><input value={draft.authUser} placeholder="Same as username" spellCheck={false} autoComplete="off" onChange={e => set('authUser', e.target.value)} /></label>
          <label className="form-row"><span className="row-label">Caller ID Name</span><input value={draft.displayName} placeholder="None" onChange={e => set('displayName', e.target.value)} /></label>
          {!wss && <label className="form-row"><span className="row-label">Outbound Proxy</span><input value={draft.proxy} placeholder="None" spellCheck={false} autoComplete="off" onChange={e => set('proxy', e.target.value)} /></label>}
          {!wss && <div className="form-row"><span className="row-label">Media</span><Segmented label="Media encryption" value={draft.mediaEncryption} options={[{ value: 'none', label: 'RTP' }, { value: 'srtp', label: 'SRTP required' }]} onChange={v => set('mediaEncryption', v)} /></div>}
          <label className="form-row"><span className="row-label">STUN Server</span><input value={draft.stun} placeholder="None" spellCheck={false} autoComplete="off" onChange={e => set('stun', e.target.value)} /></label>
          {wss && <>
            <label className="form-row"><span className="row-label">TURN Server</span><input value={draft.turn} placeholder="None" spellCheck={false} autoComplete="off" onChange={e => set('turn', e.target.value)} /></label>
            <label className="form-row"><span className="row-label">TURN Username</span><input value={draft.turnUser} spellCheck={false} autoComplete="off" onChange={e => set('turnUser', e.target.value)} /></label>
            <label className="form-row"><span className="row-label">TURN Password</span><input type="password" value={secret.turnPassword} autoComplete="new-password" onChange={e => setSecret(s => ({ ...s, turnPassword: e.target.value }))} /></label>
          </>}
          <label className="form-row"><span className="row-label">Voicemail</span><input value={draft.voicemail} placeholder="Access number, e.g. *97" spellCheck={false} onChange={e => set('voicemail', e.target.value)} /></label>
        </div>
        <div className="form-group">
          <ToggleRow label="Outbound calls only" description="Don’t register with the server. Calls go out and authenticate on their own; incoming calls won’t reach DialDev." checked={!!draft.outboundOnly} onChange={v => set('outboundOnly', v)} />
          <ToggleRow label="Register automatically" description="Register on save and whenever DialDev opens." checked={draft.enabled} onChange={v => set('enabled', v)} />
          {window.desktop && <ToggleRow label="Remember password" description="Encrypted on this computer with the system credential store." checked={remember} onChange={setRemember} />}
        </div>
      </>}
      {!window.desktop && <p className="form-note">The browser preview supports WebRTC (WSS) only and keeps passwords in memory. Use the desktop app for UDP, TCP and TLS.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="sheet-actions">
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy}>{busy ? 'Saving…' : mode === 'edit' ? 'Save' : 'Add Account'}</button>
      </div>
    </form>
  </Sheet>;
}
