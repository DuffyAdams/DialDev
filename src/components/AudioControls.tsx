import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, Mic, MicOff, Play, Volume2, VolumeX, Settings, AudioLines } from 'lucide-react';
import type { Account, Call, Preferences } from '../types';
import { phone } from '../lib/phone';
import { deviceOptions, playTestTone, useDevices, useLevel, useMicrophone } from '../lib/audio';
import { errorText, volumeOf } from '../lib/utils';
import { Meter } from './UI';

export type AudioPanel = 'mic' | 'speaker' | null;
type Props = {
  call?: Call; account?: Account; preferences: Preferences; setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  open: AudioPanel; setOpen: (panel: AudioPanel) => void; openSettings: () => void;
};
const isNative = (id: string) => id.startsWith('native:');
const speakerBody = 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z';
const waves: [string, number][] = [['M16 9a5 5 0 0 1 0 6', .08], ['M19.364 18.364a9 9 0 0 0 0-12.728', .42]];
const svg = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

/** The microphone glyph, its capsule filling from the bottom with the input level. Red near clipping. */
function MicGlyph({ level }: { level: number }) {
  const clip = `mic-${useId().replace(/[^\w-]/g, '')}`; const fill = Math.max(0, level) * 13;
  return <svg {...svg}>
    <clipPath id={clip}><rect x="9" y="2" width="6" height="13" rx="3" /></clipPath>
    <rect className={`level-fill ${level >= .95 ? 'peak' : ''}`} clipPath={`url(#${clip})`} x="9" y={15 - fill} width="6" height={fill} stroke="none" />
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" />
  </svg>;
}
/** The speaker glyph, its sound waves lighting up in turn with the output level. */
function SpeakerGlyph({ level }: { level: number }) {
  return <svg {...svg}><path d={speakerBody} />{waves.map(([d, from]) => <g key={d}>
    <path d={d} className="wave" /><path d={d} className={`level-stroke ${level >= .95 ? 'peak' : ''}`} style={{ opacity: Math.max(0, Math.min(1, (level - from) / .3)) }} />
  </g>)}</svg>;
}

/** A WebRTC call's microphone and remote audio, checked each second because they arrive after the call starts. */
function useCallMedia(id?: string) {
  const [media, setMedia] = useState<{ local?: MediaStream; remote?: MediaStream }>({});
  useEffect(() => {
    if (!id) { setMedia({}); return; }
    const key = (m: { local?: MediaStream; remote?: MediaStream }) => [m.local, m.remote].map(s => `${s?.id}:${s?.getAudioTracks().length}`).join();
    const check = () => { const next = phone.getMedia(id); setMedia(previous => key(previous) === key(next) ? previous : next); };
    check(); const timer = setInterval(check, 1000); return () => clearInterval(timer);
  }, [id]);
  return media;
}

/** Positions itself under the number field, or above it when there is no room below. Closes on Escape or a click outside. */
function AudioPopover({ anchor, label, onClose, children }: { anchor: React.RefObject<HTMLButtonElement | null>; label: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null); const [top, setTop] = useState<number>();
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useLayoutEffect(() => {
    const box = anchor.current?.parentElement?.getBoundingClientRect(); const height = ref.current?.offsetHeight || 0; if (!box) return;
    setTop(box.bottom + 6 + height > innerHeight - 6 ? Math.max(6, box.top - 6 - height) : box.bottom + 6);
  }, [anchor]);
  useEffect(() => {
    (ref.current?.querySelector<HTMLElement>('input:not(:disabled), [aria-checked=true]:not(:disabled)') || ref.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeRef.current(); } };
    const away = () => closeRef.current();
    document.addEventListener('keydown', key); window.addEventListener('resize', away);
    return () => { document.removeEventListener('keydown', key); window.removeEventListener('resize', away); };
  }, []);
  return <div className="popover-layer" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="popover audio-popover" style={{ top, visibility: top === undefined ? 'hidden' : undefined }} ref={ref} role="dialog" aria-label={label}>{children}</div>
  </div>;
}

/**
 * Microphone and speaker buttons for the edges of a number field. Each glyph shows its live level and opens quick device and
 * volume controls. WebRTC calls are metered from the call itself. Native SIP calls use the Mac's default devices outside this page,
 * so their microphone is metered from the default input, and their speaker level is not available here.
 */
export default function AudioControls({ call, account, preferences: prefs, setPreference, open, setOpen, openSettings }: Props) {
  const micButton = useRef<HTMLButtonElement>(null); const speakerButton = useRef<HTMLButtonElement>(null);
  const [tone, setTone] = useState<MediaStream | null>(null); const [error, setError] = useState('');
  const live = !!call && call.state !== 'ringing';
  const native = call ? isNative(call.id) : !!account && account.transport !== 'wss';
  const media = useCallMedia(live && !call.demo && !isNative(call.id) ? call.id : undefined);
  // Without the call's own stream, open the microphone the call is using: the Mac's default for native calls.
  const mic = useMicrophone(!media.local && (live || open === 'mic'), live && native ? '' : prefs.input);
  const devices = useDevices(mic.stream);
  const volume = volumeOf(prefs.volume);
  const micLevel = useLevel(media.local || mic.stream);
  const speakerLevel = useLevel(tone || media.remote, tone ? 1 : volume);
  const micShown = call && (call.muted || call.state === 'held') && micLevel >= 0 ? 0 : micLevel;
  const speakerUnavailable = live && native && !tone;
  useEffect(() => { setError(''); }, [open]);

  const setOutput = (id: string) => { setPreference('output', id); void phone.setOutput(id).catch(e => setError(errorText(e))); };
  const test = () => { setError(''); void playTestTone(prefs.output, volume, () => setTone(null)).then(setTone).catch(e => setError(errorText(e))); };
  const micStatus = call?.muted ? 'Muted' : call?.state === 'held' ? 'On Hold' : mic.error ? 'Unavailable' : micLevel >= 0 ? 'Live' : 'Starting…';
  const micNote = live && native ? 'This call uses the Mac’s default microphone.'
    : live && !call.demo ? 'A new microphone takes effect from your next call.'
    : native ? 'For WebRTC calls. UDP, TCP and TLS calls use the Mac’s default microphone.' : '';
  const speakerNote = live && native ? 'This call plays through the Mac’s default output at the system volume, so its level isn’t shown here.'
    : native ? 'For WebRTC calls and the test tone. UDP, TCP and TLS calls play through the Mac’s default output.' : '';
  /** The devices of one kind as checkmark rows, like the Mac's Sound menu. System Default names the device it currently means. */
  const deviceList = (kind: MediaDeviceKind, fallback: string, value: string, select: (id: string) => void, disabled = false) => {
    const current = devices.find(d => d.kind === kind && d.deviceId === 'default')?.label.replace(/^Default\s*-\s*/, '');
    return <div className="device-list" role="radiogroup" aria-label={kind === 'audioinput' ? 'Microphone' : 'Speaker'}>
      {[{ id: '', label: 'System Default', detail: current }, ...deviceOptions(devices, kind, fallback)].map(d => <button type="button" key={d.id || 'default'} role="radio" aria-checked={d.id === value} className="device-row" disabled={disabled} title={d.label} onClick={() => select(d.id)}>
        <span className="device-check">{d.id === value && <Check size={14} strokeWidth={2.4} />}</span><span className="device-name">{d.label}</span>{'detail' in d && d.detail && <span className="device-detail">{d.detail}</span>}
      </button>)}
    </div>;
  };
  const settingsLink = <button type="button" className="popover-action" onClick={() => { setOpen(null); openSettings(); }}><Settings size={15} strokeWidth={1.9} />Audio Settings…</button>;

  return <>
    <button type="button" ref={micButton} className={`level-button mic ${call?.muted ? 'muted' : ''}`} aria-haspopup="dialog" aria-expanded={open === 'mic'} aria-label="Microphone"
      title={call?.muted ? 'Microphone muted' : 'Microphone level and device'} onClick={() => setOpen(open === 'mic' ? null : 'mic')}>
      {call?.muted ? <MicOff size={20} strokeWidth={2} /> : <MicGlyph level={micShown} />}
    </button>
    <button type="button" ref={speakerButton} className={`level-button speaker ${speakerUnavailable ? 'unavailable' : ''}`} aria-haspopup="dialog" aria-expanded={open === 'speaker'} aria-label="Speaker"
      title={speakerUnavailable ? 'Speaker level isn’t available for native SIP calls' : 'Speaker level, device and volume'} onClick={() => setOpen(open === 'speaker' ? null : 'speaker')}>
      {volume === 0 ? <VolumeX size={20} strokeWidth={2} /> : <SpeakerGlyph level={speakerLevel} />}
    </button>
    {open === 'mic' && <AudioPopover anchor={micButton} label="Microphone" onClose={() => setOpen(null)}>
      <div className="popover-heading"><span>Microphone</span><span>{micStatus}</span></div>
      <div className="popover-row">{call?.muted ? <MicOff size={15} strokeWidth={1.9} /> : <Mic size={15} strokeWidth={1.9} />}<Meter level={micShown} label="Microphone level" /></div>
      <div className="popover-section">
        {deviceList('audioinput', 'Microphone', live && native ? '' : prefs.input, id => setPreference('input', id), live && native)}
        {(mic.error || micNote) && <p className={`popover-note ${mic.error ? 'error' : ''}`}>{mic.error || micNote}</p>}
      </div>
      {settingsLink}
    </AudioPopover>}
    {open === 'speaker' && <AudioPopover anchor={speakerButton} label="Speaker" onClose={() => setOpen(null)}>
      <div className="popover-heading"><span>Speaker</span><span>{Math.round(volume * 100)}%</span></div>
      <label className="popover-row"><VolumeX size={15} strokeWidth={1.9} aria-hidden="true" />
        <input type="range" className="volume-slider" aria-label="Call volume" min={0} max={100} step={1} value={Math.round(volume * 100)} style={{ '--value': `${volume * 100}%` } as React.CSSProperties} onChange={e => setPreference('volume', Number(e.target.value) / 100)} />
        <Volume2 size={15} strokeWidth={1.9} aria-hidden="true" />
      </label>
      <div className="popover-row"><AudioLines size={15} strokeWidth={1.9} /><Meter level={speakerLevel} label="Speaker level" /></div>
      <div className="popover-section">
        {deviceList('audiooutput', 'Speaker', prefs.output, setOutput)}
        {(error || speakerNote) && <p className={`popover-note ${error ? 'error' : ''}`}>{error || speakerNote}</p>}
      </div>
      <button type="button" className="popover-action" disabled={!!tone} onClick={test}><Play size={15} strokeWidth={1.9} />{tone ? 'Playing Test Tone…' : 'Play Test Tone'}</button>
      {settingsLink}
    </AudioPopover>}
  </>;
}
