import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Phone, PhoneOff, Delete, Mic, MicOff, Pause, Play, Plus, ArrowRightLeft, Merge, Split, Video, VideoOff, Voicemail, ArrowLeft, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Account, Call, Connection, Contact, HistoryItem, LogEntry, Preferences } from '../types';
import { phone, simulated, testLine } from '../lib/phone';
import { keyTone } from '../lib/tones';
import { accountLabel, duration, normalize } from '../lib/utils';
import { Avatar, IconButton } from './UI';
import AudioControls, { type AudioPanel } from './AudioControls';

const keys = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
const run = (action: () => unknown) => { try { void Promise.resolve(action()).catch(e => phone.fail(e)); } catch (e) { phone.fail(e); } };

function DtmfDisplay({ digits, ready }: { digits: string; ready: boolean }) {
  const track = useRef<HTMLSpanElement>(null); const measure = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState({ text: digits, size: 28 });
  useLayoutEffect(() => {
    const container = track.current; const ruler = measure.current;
    if (!container || !ruler) return;
    const fit = () => {
      const width = container.clientWidth;
      if (!width || !digits) return;
      const fits = (text: string, size: number) => {
        ruler.textContent = text; ruler.style.fontSize = `${size}px`;
        return ruler.getBoundingClientRect().width <= width;
      };
      // Keep the full history until it no longer fits at the smallest readable size.
      let size = 28;
      while (size > 15 && !fits(digits, size)) size--;
      let text = digits;
      if (!fits(text, size)) {
        let low = 0; let high = digits.length;
        while (low < high) {
          const count = Math.ceil((low + high) / 2);
          if (fits(`…${digits.slice(-count)}`, size)) low = count;
          else high = count - 1;
        }
        text = `…${low ? digits.slice(-low) : ''}`;
      }
      setDisplay(previous => previous.text === text && previous.size === size ? previous : { text, size });
    };
    fit();
    const observer = new ResizeObserver(fit); observer.observe(container);
    return () => observer.disconnect();
  }, [digits]);
  return <span ref={track} className="dtmf-track">
    <span ref={measure} className="dtmf-measure" aria-hidden="true" />
    <span className="dtmf-text" style={digits ? { fontSize: display.size } : undefined} aria-live="polite" aria-label={digits || undefined} title={digits ? `DTMF digits sent on this call: ${digits}` : undefined}>{digits ? display.text : ready ? 'Keypad sends DTMF' : 'Waiting to connect…'}</span>
  </span>;
}

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
  return <div className="video-stage"><video ref={remote} autoPlay playsInline muted /><video ref={local} autoPlay playsInline muted className="video-local" />
    <button type="button" className={`video-camera ${call.cameraOff ? 'on' : ''}`} aria-pressed={call.cameraOff} aria-label={call.cameraOff ? 'Turn camera on' : 'Turn camera off'} title={call.cameraOff ? 'Turn camera on' : 'Turn camera off'} onClick={() => run(() => phone.camera(call.id))}>{call.cameraOff ? <VideoOff size={16} strokeWidth={2} /> : <Video size={16} strokeWidth={2} />}</button>
  </div>;
}
export const callState = (call: Call, now: number) => call.state === 'active' ? duration((now - (call.answered || now)) / 1000) : call.state === 'held' ? 'On Hold' : call.state === 'ringing' ? 'Incoming' : call.progress === 'ringing' ? 'Ringing…' : call.progress === 'early' ? 'Early media…' : 'Calling…';

type Props = {
  accounts: Account[]; account?: Account; connections: Record<string, Connection>; register: (a: Account) => void; addAccount: () => void;
  calls: Call[]; focused: string; setFocused: (id: string) => void; number: string; setNumber: Dispatch<SetStateAction<string>>; dial: (target?: string, video?: boolean) => void;
  contacts: Contact[]; history: HistoryItem[]; preferences: Preferences; setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void; openAudioSettings: () => void;
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
  const [now, setNow] = useState(Date.now()); const [adding, setAdding] = useState(false); const [audio, setAudio] = useState<AudioPanel>(null);
  const [canCaption, setCanCaption] = useState(testLine.enabled);
  useEffect(() => { void phone.transcriptionInfo().then(info => setCanCaption(info.available || testLine.enabled)); }, [p.preferences.transcribeLocale]);
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
    if (p.blocked || audio || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement; const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
    if (live && !typing && /^[0-9*#]$/.test(event.key)) { event.preventDefault(); digit(event.key); return; }
    if (showCall || typing) return;
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

  if (!p.accounts.length && !testLine.enabled) return <section className="phone"><div className="phone-empty">
    <span className="phone-empty-icon"><Phone size={26} strokeWidth={1.5} /></span><strong>No SIP Account</strong>
    <p>Add your SIP server’s hostname, a username and password. The account registers as soon as you save it.</p>
    <button type="button" className="button primary" onClick={p.addAccount}>Add Account…</button>
  </div></section>;

  // The dial pad and the call screen share one layout, so the keypad, number field and call button stay put when a call starts.
  // Room for the caption and call details is kept whenever they can appear, so they never move the keypad either.
  const screen = `screen ${p.preferences.callDetails ? 'details' : ''} ${p.preferences.transcribe && p.preferences.captions && canCaption ? 'captions' : ''}`;
  const audioControls = (call?: Call) => <AudioControls call={call} account={p.account} preferences={p.preferences} setPreference={p.setPreference} open={audio} setOpen={setAudio} openSettings={p.openAudioSettings} />;
  const add = () => { setAdding(true); p.setNumber(''); };
  const strip = (p.calls.length > 1 || adding) && <div className="call-strip">{p.calls.map(c => <button type="button" key={c.id} className={`${c.id === current?.id && !adding ? 'selected' : ''} ${c.state}`} onClick={() => { p.setFocused(c.id); setAdding(false); }}>
    <span className="strip-dot" /><span className="strip-name">{c.name}</span><span className="strip-state">{callState(c, now)}</span>
  </button>)}{!adding && p.calls.length < 5 && <button type="button" className="strip-add" aria-label="Add call" title="Add call" onClick={add}><Plus size={15} strokeWidth={2} /></button>}</div>;

  if (showCall && current) {
    const account = p.accounts.find(a => a.id === current.accountId); const ringing = current.state === 'ringing'; const answered = !!current.answered; const held = current.state === 'held';
    const merge = answered && p.calls.filter(c => c.answered).length > 1;
    const details = p.preferences.callDetails && <p className="call-details" title={current.uri || current.number}>{current.uri || current.number} · {ringing ? 'to' : 'via'} {current.demo ? 'Simulator' : account ? accountLabel(account) : 'SIP account'}</p>;
    const status = <>{current.name !== current.number && <span className="call-number">{current.number}</span>}<span className={`call-state ${current.state}`}>{ringing ? `Incoming ${current.video ? 'video ' : ''}call` : callState(current, now)}</span>{current.muted && <span className="flag">Muted</span>}{current.recording && <button type="button" className="flag rec" title="Stop recording" onClick={() => run(() => phone.record(current.id))}>REC</button>}{current.conference && <span className="flag">Conference</span>}</>;
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
    // Two controls either side of End. With a second connected call, Merge takes Add's place and Add moves to the call strip.
    const control = (c: { label: string; icon: LucideIcon; on?: boolean; action: () => unknown; enabled?: boolean }) => <button type="button" key={c.label} className={`control ${c.on ? 'on' : ''}`} aria-pressed={c.on} disabled={!answered || c.enabled === false} onClick={() => run(c.action)}><span><c.icon size={18} strokeWidth={1.9} /></span>{c.label}</button>;
    const left = [
      { label: current.muted ? 'Unmute' : 'Mute', icon: current.muted ? MicOff : Mic, on: current.muted, action: () => phone.mute(current.id) },
      { label: held ? 'Resume' : 'Hold', icon: held ? Play : Pause, on: held, action: () => phone.hold(current.id, !held) }
    ];
    const right = [
      { label: 'Transfer', icon: ArrowRightLeft, action: () => p.transfer(current) },
      merge ? { label: current.conference ? 'Split' : 'Merge', icon: current.conference ? Split : Merge, on: current.conference, action: () => current.conference ? phone.splitConference(current.id) : phone.merge() }
        : { label: 'Add', icon: Plus, action: add, enabled: p.calls.length < 5 }
    ];
    const dtmfReady = answered || current.progress === 'early'; const captions = current.transcribing && p.preferences.captions;
    return <section className="phone">{strip}<div className="screen-frame">
      <div className={`${screen} in-call`}>
        <div className="screen-top">
          {current.video && answered && <VideoView call={current} />}
          <h2 className="call-name" title={current.name}>{current.name}</h2>
          <p className="call-status">{status}</p>{details}
          {captions && <Caption call={current} log={p.log} now={now} />}
        </div>
        <div className={`number-field dtmf ${current.dtmf ? '' : 'idle'}`}>
          {audioControls(current)}
          <DtmfDisplay digits={current.dtmf} ready={dtmfReady} />
        </div>
        <Keypad press={digit} disabled={!dtmfReady} />
        <div className="screen-actions call-actions">
          {left.map(control)}
          <button type="button" className="round decline main-call" aria-label="End call" onClick={() => run(() => phone.end(current.id))}><PhoneOff size={28} /></button>
          {right.map(control)}
        </div>
      </div>
    </div></section>;
  }

  const failed = p.ended && (p.ended.direction === 'missed' || (!p.ended.duration && p.ended.direction === 'outgoing'));
  const hint = adding ? <button type="button" className="back-link" onClick={() => setAdding(false)}><ArrowLeft size={13} />Back to call</button>
    : testLine.enabled && p.number.trim() === testLine.number ? <span className="dial-notice">{testLine.name} · simulated, no SIP needed</span>
    : match ? <button type="button" className="dial-match" onClick={() => { p.setNumber(match.number); input.current?.focus(); }}><strong>{match.name}</strong>{match.number}</button>
    : p.ended ? <span className={`dial-notice ${failed ? 'failed' : ''}`}>{p.ended.direction === 'missed' ? `Missed call from ${p.ended.name}` : failed ? 'Call failed' : 'Call ended'}{p.ended.reason && (failed || /^[3-6]\d\d/.test(p.ended.reason)) ? ` · ${p.ended.reason}` : p.ended.duration ? ` · ${duration(p.ended.duration)}` : ''}</span>
    : !p.account ? <span className="dial-notice warning">No SIP account · dial {testLine.number} to try<button type="button" className="text-button" onClick={p.addAccount}>Add</button></span>
    : !ready ? <span className="dial-notice warning"><TriangleAlert size={12} />{connection?.state === 'connecting' ? connection.detail || 'Registering…' : connection?.state === 'error' ? 'Registration failed' : 'Not registered'}{connection?.state !== 'connecting' && <button type="button" className="text-button" onClick={() => p.register(p.account!)}>{connection?.state === 'error' ? 'Retry' : 'Register'}</button>}</span>
    : null;
  const canCall = ready || simulated(p.number, p.calls);
  return <section className="phone">{strip}<div className="screen-frame">
    <div className={`${screen} dialer`}>
      <div className="screen-top"><div className="dial-hint">{hint}</div></div>
      <div className="number-field dial-display">
        <input ref={input} id="dial-number" className={`dial-input ${!p.number ? 'empty' : p.number.length > 22 ? 'xs' : p.number.length > 13 ? 'sm' : ''}`} aria-label="Number or SIP address" placeholder="Number or SIP URI" autoComplete="off" spellCheck={false} value={p.number}
          onChange={e => p.setNumber(e.target.value.replace(/[\r\n]/g, ''))} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); p.dial(); } if (e.key === 'Escape' && p.number) { e.preventDefault(); p.setNumber(''); } }} />
        {audioControls(p.calls.find(c => c.state === 'active'))}
      </div>
      <Keypad press={press} />
      <div className="screen-actions dial-actions">
        <div className="dial-side">
          {p.account?.voicemail && <span className="dial-voicemail"><IconButton icon={Voicemail} label={p.voicemailCount ? `Voicemail (${p.voicemailCount} new)` : `Voicemail (${p.account.voicemail})`} size={22} onClick={p.voicemail} />{p.voicemailCount > 0 && <span className="badge">{p.voicemailCount}</span>}</span>}
          {p.account?.transport === 'wss' && <IconButton icon={Video} label="Video call" size={22} disabled={!ready || !p.number.trim()} onClick={() => p.dial(undefined, true)} />}
        </div>
        <button type="button" className="round accept main-call" aria-label={p.number.trim() ? 'Call' : 'Redial last number'} title={!canCall ? (p.account || !testLine.enabled ? 'The selected account is not registered' : `Add a SIP account, or dial ${testLine.number} for a test call`) : p.number.trim() ? 'Call (↵)' : 'Recall last dialed number'} disabled={!canCall} onClick={() => p.dial()}><Phone size={28} fill="currentColor" strokeWidth={1} /></button>
        <div className="dial-side">{p.number && <IconButton icon={Delete} label="Delete (⌫)" className="dial-delete" size={24} onClick={() => { p.setNumber(n => n.slice(0, -1)); input.current?.focus(); }} />}</div>
      </div>
    </div>
  </div></section>;
}
