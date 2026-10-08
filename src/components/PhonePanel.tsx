import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Phone, PhoneOff, Delete, Mic, MicOff, Pause, Play, Plus, ArrowRightLeft, Disc, Merge, Split, Video, VideoOff, Voicemail, ArrowLeft, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Account, Call, Connection, Contact, HistoryItem, LogEntry, Preferences } from '../types';
import { phone } from '../lib/phone';
import { keyTone } from '../lib/tones';
import { accountLabel, duration, normalize } from '../lib/utils';
import { Avatar, IconButton } from './UI';

const keys = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
const run = (action: () => unknown) => { try { void Promise.resolve(action()).catch(e => phone.fail(e)); } catch (e) { phone.fail(e); } };

/**
 * Phone keypad. Keys fire on press rather than release so fast mouse input is not lost, and each key's hit area fills its
 * whole grid cell. 0 waits for release so that holding it (or right-clicking it) enters + instead.
 */
export function Keypad({ press, disabled = false }: { press: (key: string) => void; disabled?: boolean }) {
  const zero = useRef<{ timer?: ReturnType<typeof setTimeout>; down: boolean }>({ down: false });
  const down = (event: React.PointerEvent, key: string) => {
    if (event.button !== 0) return; event.preventDefault();
    if (key !== '0') { press(key); return; }
    zero.current.down = true; zero.current.timer = setTimeout(() => { zero.current.down = false; press('+'); }, 550);
  };
  const up = (key: string) => { if (key !== '0' || !zero.current.down) return; clearTimeout(zero.current.timer); zero.current.down = false; press('0'); };
  const cancel = () => { clearTimeout(zero.current.timer); zero.current.down = false; };
  return <div className={`keypad ${disabled ? 'disabled' : ''}`}>{keys.map(([key, letters]) => <button type="button" key={key} className="key" disabled={disabled} aria-label={key === '*' ? 'Star' : key === '#' ? 'Pound' : key}
    onPointerDown={e => down(e, key)} onPointerUp={() => up(key)} onPointerLeave={cancel}
    onClick={e => { if (e.detail === 0) press(key); }}
    onContextMenu={e => { if (key === '0') { e.preventDefault(); cancel(); press('+'); } }}>
    <span className="key-face"><span className="key-digit">{key}</span>{letters && <span className="key-letters">{letters}</span>}</span>
  </button>)}</div>;
}
function VideoView({ call }: { call: Call }) {
  const local = useRef<HTMLVideoElement>(null); const remote = useRef<HTMLVideoElement>(null);
  useEffect(() => { const attach = () => { const media = phone.getMedia(call.id); if (local.current && media.local && local.current.srcObject !== media.local) local.current.srcObject = media.local; if (remote.current && media.remote && remote.current.srcObject !== media.remote) remote.current.srcObject = media.remote; }; attach(); const timer = setInterval(attach, 1000); return () => clearInterval(timer); }, [call.id]);
  return <div className="video-stage"><video ref={remote} autoPlay playsInline muted /><video ref={local} autoPlay playsInline muted className="video-local" /></div>;
}
export const callState = (call: Call, now: number) => call.state === 'active' ? duration((now - (call.answered || now)) / 1000) : call.state === 'held' ? 'On Hold' : call.state === 'ringing' ? 'Incoming' : call.progress === 'ringing' ? 'Ringing…' : call.progress === 'early' ? 'Early media…' : 'Calling…';

type Props = {
  accounts: Account[]; account?: Account; connections: Record<string, Connection>; register: (a: Account) => void; addAccount: () => void;
  calls: Call[]; focused: string; setFocused: (id: string) => void; number: string; setNumber: Dispatch<SetStateAction<string>>; dial: (target?: string, video?: boolean) => void;
  contacts: Contact[]; history: HistoryItem[]; preferences: Preferences;
  voicemailCount: number; voicemail: () => void; transfer: (call: Call) => void; ended: HistoryItem | null; blocked: boolean; log: LogEntry[];
};
/** The latest speech on a call from the last 20 seconds, trimmed to its end so the newest words show. */
function Caption({ call, log, now }: { call: Call; log: LogEntry[]; now: number }) {
  let line: LogEntry | undefined; for (let i = log.length - 1; i >= 0 && !line; i--) if (log[i].callId === call.id && log[i].kind === 'speech') line = log[i];
  if (!line || (!line.partial && now - line.time > 20000)) return <p className="call-caption idle" aria-live="polite">Listening…</p>;
  const text = line.text.length > 96 ? `…${line.text.slice(-95)}` : line.text;
  return <p className={`call-caption ${line.partial ? 'partial' : ''}`} aria-live="polite" title={line.text}>{line.side === 'local' && <span className="caption-speaker">You</span>}{text}</p>;
}
export default function PhonePanel(p: Props) {
  const [now, setNow] = useState(Date.now()); const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const current = p.calls.find(c => c.id === p.focused) || p.calls.at(-1);
  const showCall = !!current && !adding; const live = !!current?.answered && showCall;
  const connection = p.account ? p.connections[p.account.id] : undefined; const ready = connection?.state === 'registered';
  const hasCalls = p.calls.length > 0;
  useEffect(() => { if (!hasCalls) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [hasCalls]);
  useEffect(() => { setAdding(false); }, [p.calls.length]);
  const tone = (key: string) => { if (p.preferences.sounds) keyTone(key); };
  const digit = (key: string) => { if (!current) return; tone(key); run(() => phone.dtmf(current.id, key)); };
  const press = (key: string) => { tone(key); p.setNumber(n => n + key); requestAnimationFrame(() => input.current?.focus()); };
  // Typing digits sends DTMF during a connected call, or edits the number when dialing.
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keyRef.current = event => {
    if (p.blocked || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement; const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
    if (live && !typing && /^[0-9*#]$/.test(event.key)) { event.preventDefault(); digit(event.key); return; }
    if (showCall || typing || !p.account) return;
    if (/^[0-9*#+]$/.test(event.key)) { event.preventDefault(); press(event.key); }
    else if (event.key === 'Backspace') { event.preventDefault(); p.setNumber(n => n.slice(0, -1)); input.current?.focus(); }
    else if (event.key === 'Enter' && p.number.trim() && target.tagName !== 'BUTTON') { event.preventDefault(); p.dial(); }
  };
  useEffect(() => { const listener = (event: KeyboardEvent) => keyRef.current(event); window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, []);
  const match = useMemo(() => {
    const query = p.number.trim().toLowerCase(); if (!query) return undefined; const digits = normalize(query);
    const contact = p.contacts.find(c => (/[a-z]/.test(query) && c.name.toLowerCase().includes(query)) || (digits.length > 1 && normalize(c.number).startsWith(digits)));
    if (contact) return { name: contact.name, number: contact.number };
    const recent = digits.length > 1 ? p.history.find(h => normalize(h.number).startsWith(digits) && normalize(h.number) !== digits) : undefined;
    return recent && { name: recent.name !== recent.number ? recent.name : 'Recent', number: recent.number };
  }, [p.number, p.contacts, p.history]);

  const strip = (p.calls.length > 1 || adding) && <div className="call-strip">{p.calls.map(c => <button type="button" key={c.id} className={`${c.id === current?.id && !adding ? 'selected' : ''} ${c.state}`} onClick={() => { p.setFocused(c.id); setAdding(false); }}>
    <span className="strip-dot" /><span className="strip-name">{c.name}</span><span className="strip-state">{callState(c, now)}</span>
  </button>)}</div>;

  if (!p.accounts.length) return <section className="phone"><div className="phone-empty">
    <span className="phone-empty-icon"><Phone size={26} strokeWidth={1.5} /></span><strong>No SIP Account</strong>
    <p>Add your SIP server’s hostname, a username and password. The account registers as soon as you save it.</p>
    <button type="button" className="button primary" onClick={p.addAccount}>Add Account…</button>
  </div></section>;

  if (showCall && current) {
    const account = p.accounts.find(a => a.id === current.accountId); const ringing = current.state === 'ringing'; const answered = !!current.answered; const held = current.state === 'held';
    const merge = answered && p.calls.filter(c => c.answered).length > 1;
    const details = p.preferences.callDetails && <p className="call-details" title={current.uri || current.number}>{current.uri || current.number} · {ringing ? 'to' : 'via'} {current.demo ? 'Simulator' : account ? accountLabel(account) : 'SIP account'}</p>;
    const status = <>{current.name !== current.number && <span className="call-number">{current.number}</span>}<span className={`call-state ${current.state}`}>{ringing ? `Incoming ${current.video ? 'video ' : ''}call` : callState(current, now)}</span>{current.muted && <span className="flag">Muted</span>}{current.recording && <span className="flag rec">REC</span>}{current.conference && <span className="flag">Conference</span>}</>;
    if (ringing) return <section className="phone">{strip}
      <div className="call ringing">
        <div className="call-avatar pulse"><Avatar name={current.name} size={72} /></div>
        <h2 className="call-name" title={current.name}>{current.name}</h2>
        <p className="call-status">{status}</p>{details}
        <div className="answer-row">
          <div><button type="button" className="round decline" aria-label="Decline" onClick={() => run(() => phone.end(current.id))}><PhoneOff size={26} /></button><span>Decline</span></div>
          <div><button type="button" className="round accept" aria-label="Answer" autoFocus onClick={() => run(() => phone.answer(current.id, current.video))}><Phone size={26} fill="currentColor" strokeWidth={1} /></button><span>Answer</span></div>
        </div>
      </div>
    </section>;
    const controls: { label: string; icon: LucideIcon; on?: boolean; red?: boolean; action: () => unknown; enabled?: boolean }[] = [
      { label: current.muted ? 'Unmute' : 'Mute', icon: current.muted ? MicOff : Mic, on: current.muted, action: () => phone.mute(current.id) },
      { label: held ? 'Resume' : 'Hold', icon: held ? Play : Pause, on: held, action: () => phone.hold(current.id, !held) },
      { label: current.recording ? 'Stop' : 'Record', icon: Disc, on: current.recording, red: true, action: () => phone.record(current.id), enabled: !current.demo },
      { label: 'Transfer', icon: ArrowRightLeft, action: () => p.transfer(current) },
      { label: 'Add', icon: Plus, action: () => { setAdding(true); p.setNumber(''); }, enabled: p.calls.length < 5 },
      ...(merge ? [{ label: current.conference ? 'Split' : 'Merge', icon: current.conference ? Split : Merge, on: current.conference, action: () => current.conference ? phone.splitConference(current.id) : phone.merge() }] : []),
      ...(current.video ? [{ label: 'Camera', icon: current.cameraOff ? VideoOff : Video, on: current.cameraOff, action: () => phone.camera(current.id) }] : [])
    ];
    const dtmfReady = answered || current.progress === 'early'; const captions = current.transcribing && p.preferences.captions;
    return <section className="phone">{strip}
      <div className={`call ${captions ? 'captioned' : ''}`}>
        {current.video && answered && <VideoView call={current} />}
        <h2 className="call-name" title={current.name}>{current.name}</h2>
        <p className="call-status">{status}</p>{details}
        {captions && <Caption call={current} log={p.log} now={now} />}
        <div className={`number-field dtmf ${current.dtmf ? '' : 'empty'}`} aria-live="polite" title="DTMF digits sent on this call">{current.dtmf.slice(-18) || (dtmfReady ? 'Keypad sends DTMF' : 'Keypad unlocks when the call connects')}</div>
        <Keypad press={digit} disabled={!dtmfReady} />
        <div className="call-controls">{controls.map(c => <button type="button" key={c.label} className={`control ${c.on ? 'on' : ''} ${c.on && c.red ? 'red' : ''}`} aria-pressed={c.on} disabled={!answered || c.enabled === false} onClick={() => run(c.action)}><span><c.icon size={18} strokeWidth={1.9} /></span>{c.label}</button>)}</div>
        <button type="button" className="round decline end" aria-label="End call" onClick={() => run(() => phone.end(current.id))}><PhoneOff size={26} /></button>
      </div>
    </section>;
  }

  const failed = p.ended && (p.ended.direction === 'missed' || (!p.ended.duration && p.ended.direction === 'outgoing'));
  const hint = adding ? <button type="button" className="back-link" onClick={() => setAdding(false)}><ArrowLeft size={13} />Back to call</button>
    : match ? <button type="button" className="dial-match" onClick={() => { p.setNumber(match.number); input.current?.focus(); }}><strong>{match.name}</strong>{match.number}</button>
    : p.ended ? <span className={`dial-notice ${failed ? 'failed' : ''}`}>{p.ended.direction === 'missed' ? `Missed call from ${p.ended.name}` : failed ? 'Call failed' : 'Call ended'}{p.ended.reason && (failed || /^[3-6]\d\d/.test(p.ended.reason)) ? ` · ${p.ended.reason}` : p.ended.duration ? ` · ${duration(p.ended.duration)}` : ''}</span>
    : p.account && !ready ? <span className="dial-notice warning"><TriangleAlert size={12} />{connection?.state === 'connecting' ? 'Registering…' : connection?.state === 'error' ? 'Registration failed' : 'Not registered'}{connection?.state !== 'connecting' && <button type="button" className="text-button" onClick={() => p.register(p.account!)}>{connection?.state === 'error' ? 'Retry' : 'Register'}</button>}</span>
    : null;
  return <section className="phone">{strip}
    <div className="dialer">
      <div className="number-field dial-display">
        <input ref={input} id="dial-number" className={`dial-input ${!p.number ? 'empty' : p.number.length > 22 ? 'xs' : p.number.length > 13 ? 'sm' : ''}`} aria-label="Number or SIP address" placeholder="Number or SIP URI" autoComplete="off" spellCheck={false} value={p.number}
          onChange={e => p.setNumber(e.target.value.replace(/[\r\n]/g, ''))} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); p.dial(); } if (e.key === 'Escape' && p.number) { e.preventDefault(); p.setNumber(''); } }} />
        {p.number && <IconButton icon={Delete} label="Delete" className="dial-delete" size={20} onClick={() => { p.setNumber(n => n.slice(0, -1)); input.current?.focus(); }} />}
      </div>
      <div className="dial-hint">{hint}</div>
      <Keypad press={press} />
      <div className="dial-actions">
        <div className="dial-side">{p.account?.voicemail && <IconButton icon={Voicemail} label={p.voicemailCount ? `Voicemail (${p.voicemailCount} new)` : `Voicemail (${p.account.voicemail})`} size={22} onClick={p.voicemail} />}{p.voicemailCount > 0 && <span className="badge">{p.voicemailCount}</span>}</div>
        <button type="button" className="round accept dial-call" aria-label={p.number.trim() ? 'Call' : 'Redial last number'} title={!ready ? 'The selected account is not registered' : p.number.trim() ? 'Call (↵)' : 'Recall last dialed number'} disabled={!ready} onClick={() => p.dial()}><Phone size={30} fill="currentColor" strokeWidth={1} /></button>
        <div className="dial-side">{p.account?.transport === 'wss' && <IconButton icon={Video} label="Video call" size={22} disabled={!ready || !p.number.trim()} onClick={() => p.dial(undefined, true)} />}</div>
      </div>
    </div>
  </section>;
}
