import { useEffect, useState } from 'react';
import type { Preferences, TranscriptionInfo, UpdateState } from '../types';
import { phone } from '../lib/phone';
import { deviceOptions, playTestTone, useDevices, useLevel, useMicrophone } from '../lib/audio';
import { errorText, timeLabel, volumeOf } from '../lib/utils';
import { Meter, Segmented, Sheet, ToggleRow } from './UI';

type Props = { initialTab?: 'general' | 'audio'; preferences: Preferences; setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void; update: UpdateState | null; onClose: () => void };
const updateNote = (u: UpdateState) => u.status === 'checking' ? 'Checking for updates…'
  : u.status === 'current' ? `DialDev ${u.current} is up to date.${u.checked ? ` Checked ${timeLabel(u.checked)}.` : ''}`
  : u.status === 'available' ? `DialDev ${u.version} is available. You have ${u.current}.${u.reason ? ` ${u.reason}` : ''}`
  : u.status === 'downloading' ? `Downloading DialDev ${u.version}… ${Math.round((u.progress || 0) * 100)}%`
  : u.status === 'installing' ? `Installing DialDev ${u.version}. It reopens when done.`
  : u.status === 'error' ? u.error || 'Couldn’t check for updates.' : `Version ${u.current}`;
export default function SettingsSheet({ initialTab = 'general', preferences: prefs, setPreference, update, onClose }: Props) {
  const [tab, setTab] = useState(initialTab); const [error, setError] = useState('');
  const [testing, setTesting] = useState(false); const mic = useMicrophone(testing, prefs.input); const level = useLevel(mic.stream); const devices = useDevices(mic.stream);
  const [speech, setSpeech] = useState<{ system?: TranscriptionInfo; selected?: TranscriptionInfo }>({});
  useEffect(() => { void window.desktop?.transcriptionInfo?.('').then(system => setSpeech(s => ({ ...s, system }))).catch(e => setSpeech(s => ({ ...s, system: { available: false, reason: errorText(e), locales: [] } }))); }, []);
  useEffect(() => { if (prefs.transcribeLocale) void window.desktop?.transcriptionInfo?.(prefs.transcribeLocale).then(selected => setSpeech(s => ({ ...s, selected }))).catch(() => {}); }, [prefs.transcribeLocale]);
  const speechInfo = prefs.transcribeLocale ? speech.selected : speech.system;
  const speechNote = !window.desktop?.transcriptionInfo ? 'Available in the desktop app.' : !speechInfo ? 'Checking this computer…' : !speechInfo.available ? speechInfo.reason || 'Not available on this computer.'
    : `What each side says appears in Activity. Transcribed on this Mac; audio never leaves it.${speechInfo.installed === false ? ` The ${speechInfo.language || 'language'} model downloads on first use.` : ''}`;
  const stopTest = () => setTesting(false);
  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) => { setPreference(key, value); if (key === 'output') void phone.setOutput(value as string).catch(e => setError(errorText(e))); };
  useEffect(() => { if (mic.error) { setError(mic.error); setTesting(false); } }, [mic.error]);
  const testMic = () => { setError(''); setTesting(t => !t); };
  const testSpeaker = () => { setError(''); void playTestTone(prefs.output, volumeOf(prefs.volume)).catch(e => setError(errorText(e))); };
  const options = (kind: MediaDeviceKind, fallback: string) => deviceOptions(devices, kind, fallback).map(d => <option key={d.id} value={d.id}>{d.label}</option>);
  return <Sheet title="Settings" width={500} onClose={onClose}>
    <Segmented label="Settings section" className="wide" value={tab} onChange={value => { setTab(value); stopTest(); setError(''); }} options={[{ value: 'general', label: 'General' }, { value: 'audio', label: 'Audio' }]} />
    {tab === 'general' ? <>
      <div className="form-group">
        <div className="form-row"><span className="row-label">Appearance</span><Segmented label="Appearance" value={prefs.theme} onChange={v => set('theme', v)} options={[{ value: 'system', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></div>
        <ToggleRow label="Sounds" description="Ringtone and keypad tones." checked={prefs.sounds} onChange={v => set('sounds', v)} />
        <ToggleRow label="Show Call Details" description="Show the SIP address and line on the call screen." checked={prefs.callDetails} onChange={v => set('callDetails', v)} />
        <ToggleRow label="Record Calls" description="Record both sides of each call once it connects. Click REC on the call screen to stop." checked={prefs.recordCalls} onChange={v => set('recordCalls', v)} />
      </div>
      <div className="form-group">
        <ToggleRow label="Do Not Disturb" description="Decline incoming calls with 486 Busy Here." checked={prefs.dnd} onChange={v => set('dnd', v)} />
        <ToggleRow label="Auto Answer" description="Answer incoming audio calls when no other call is active." checked={prefs.autoAnswer} onChange={v => set('autoAnswer', v)} />
        <label className="form-row"><span className="row-label">Forward To<small>302 redirect</small></span><input value={prefs.forward} placeholder="Off — number or SIP URI" spellCheck={false} onChange={e => set('forward', e.target.value)} /></label>
      </div>
      <div className="form-group">
        <ToggleRow label="Transcribe Calls" description={speechNote} checked={prefs.transcribe && speech.system?.available !== false} disabled={!speech.system?.available} onChange={v => set('transcribe', v)} />
        {speech.system?.available && <label className="form-row"><span className="row-label">Language</span><select value={prefs.transcribeLocale} disabled={!prefs.transcribe} onChange={e => set('transcribeLocale', e.target.value)}><option value="">{speech.system.language ? `${speech.system.language} — System` : 'System Language'}</option>{speech.system.locales.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
        <ToggleRow label="Show on Call Screen" description="The latest phrase appears under the caller’s name." checked={prefs.captions} disabled={!speech.system?.available || !prefs.transcribe} onChange={v => set('captions', v)} />
      </div>
      {update && <div className="form-group">
        <div className="form-row toggle-row"><span className="row-label">Software Update<small className={update.status === 'error' ? 'update-error' : ''}>{updateNote(update)}{update.status === 'available' && update.error && <span className="update-error"> {update.error}</span>}</small></span>
          {update.status === 'available' ? update.canInstall ? <button type="button" className="button small primary" onClick={() => { setError(''); void window.desktop?.updateInstall().catch(e => setError(errorText(e))); }}>Update & Restart</button>
            : <button type="button" className="button small" onClick={() => window.desktop?.openRelease()}>Download</button>
            : <button type="button" className="button small" disabled={['checking', 'downloading', 'installing'].includes(update.status)} onClick={() => void window.desktop?.updateCheck()}>Check Now</button>}
        </div>
        {update.status === 'downloading' && <div className="update-progress" role="progressbar" aria-label="Download progress" aria-valuenow={Math.round((update.progress || 0) * 100)}><span style={{ width: `${(update.progress || 0) * 100}%` }} /></div>}
        <ToggleRow label="Check Automatically" description="Look for a new version when DialDev opens." checked={prefs.checkUpdates} onChange={v => set('checkUpdates', v)} />
      </div>}
    </> : <>
      <div className="form-group">
        <label className="form-row"><span className="row-label">Microphone</span><select value={prefs.input} onChange={e => set('input', e.target.value)}><option value="">System Default</option>{options('audioinput', 'Microphone')}</select></label>
        <div className="form-row"><span className="row-label">Input Level</span><span className="meter-field"><Meter level={level} label="Input level" /><button type="button" className="button small" onClick={testMic}>{testing ? 'Stop' : 'Test'}</button></span></div>
        <label className="form-row"><span className="row-label">Speaker</span><select value={prefs.output} onChange={e => set('output', e.target.value)}><option value="">System Default</option>{options('audiooutput', 'Speaker')}</select></label>
        <div className="form-row"><span className="row-label">Call Volume</span><span className="meter-field"><input type="range" className="volume-slider" aria-label="Call volume" min={0} max={100} step={1} value={Math.round(volumeOf(prefs.volume) * 100)} style={{ '--value': `${volumeOf(prefs.volume) * 100}%` } as React.CSSProperties} onChange={e => set('volume', Number(e.target.value) / 100)} /><button type="button" className="button small" onClick={testSpeaker}>Test</button></span></div>
        <label className="form-row"><span className="row-label">Camera</span><select value={prefs.camera} onChange={e => set('camera', e.target.value)}><option value="">System Default</option>{options('videoinput', 'Camera')}</select></label>
      </div>
      <div className="form-group">
        <ToggleRow label="Echo Cancellation" checked={prefs.echoCancellation} onChange={v => set('echoCancellation', v)} />
        <ToggleRow label="Noise Suppression" checked={prefs.noiseSuppression} onChange={v => set('noiseSuppression', v)} />
      </div>
      <p className="form-note">Device choices, volume and processing apply to WebRTC (WSS) calls. UDP, TCP and TLS calls use the system default input and output.</p>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="sheet-actions"><span className="sheet-version">DialDev {update?.current || __APP_VERSION__}</span><span className="spacer" /><button type="button" className="button primary" onClick={onClose}>Done</button></div>
  </Sheet>;
}
