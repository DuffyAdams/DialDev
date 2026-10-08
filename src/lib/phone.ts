import { Invitation, Inviter, Messager, Registerer, RegistererState, Session, SessionState, Subscriber, UserAgent, Web } from 'sip.js';
import type { Account, Call, ChatMessage, Credentials, HistoryItem, LogEntry, NativeEvent, PhoneSnapshot, Preferences, TranscriptEvent, TranscriptionInfo } from '../types';
import { accountLabel, dialTarget, errorText, uid } from './utils';
import { defaults, recordings } from './storage';

type Client = { ua: UserAgent; registerer: Registerer; account: Account; subscriber?: Subscriber; timer?: ReturnType<typeof setTimeout> };
type Recorder = { recorder: MediaRecorder; context: AudioContext; started: number };
/** A call's transcription. It stays listed after the call or transcription stops, until the helper reports its last results. */
type Transcript = { accountId: string; speaker: string; active: boolean; stopCapture?: () => void };
// Native engine events worth showing in the activity log, and the ones that are too frequent or already reported elsewhere.
const eventLabels: Record<string, string> = { CALL_INCOMING: 'Incoming call', CALL_OUTGOING: 'Outgoing call', CALL_RINGING: 'Ringing', CALL_PROGRESS: 'Session progress (early media)', CALL_ANSWERED: 'Answered', CALL_ESTABLISHED: 'Call established', CALL_CLOSED: 'Call closed', CALL_RTPESTAB: 'RTP media established', CALL_MENC: 'Media encryption', CALL_TRANSFER: 'Transfer requested', CALL_TRANSFER_FAILED: 'Transfer failed', CALL_REDIRECT: 'Redirected', CALL_DTMF_START: 'DTMF received', CALL_HOLD: 'Held by remote party', CALL_RESUME: 'Resumed by remote party', CALL_LOCAL_SDP: 'Local SDP', CALL_REMOTE_SDP: 'Remote SDP', AUDIO_ERROR: 'Audio error', MWI_NOTIFY: 'Message-waiting notification', UNREGISTERING: 'Unregistering', REFER: 'REFER received' };
const quietEvents = new Set(['CALL_RTCP', 'CALL_DTMF_END', 'VU_TX', 'VU_RX', 'CREATE', 'MODULE', 'CUSTOM', 'END_OF_FILE']);
const failure = (reason?: string) => !!reason && /^[3-6]\d\d\b/.test(reason);
const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
/** Whether `heard` mostly repeats `said` (at least 3 words, 60% shared): the microphone picking up the other side. */
export function repeats(heard: string, said: string) { const mine = words(heard), theirs = words(said); if (mine.size < 3) return false; let shared = 0; for (const w of mine) if (theirs.has(w)) shared++; return shared / mine.size >= .6; }

export class PhoneEngine {
  private snapshot: PhoneSnapshot = { calls: [], connections: {}, voicemail: {}, error: null, log: [] };
  private logId = 0;
  private listeners = new Set<() => void>();
  private clients = new Map<string, Client>();
  private sessions = new Map<string, Session>();
  private audio = new Map<string, HTMLAudioElement>();
  private recorders = new Map<string, Recorder>();
  private demoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private conferenceContext?: AudioContext;
  private conferenceOriginals = new Map<string, MediaStreamTrack>();
  private nativeAccounts = new Map<string, Account>();
  private nativeRecordings = new Map<string, { call: Call; started: number }>();
  private nativeMessages = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nativeDialing?: { name: string; number: string; accountId: string };
  private transcripts = new Map<string, Transcript>();
  private transcription?: Promise<TranscriptionInfo>;
  private transcriptionNoticed = false;
  private prefs: Preferences = defaults.preferences;
  constructor() { window.desktop?.onSipEvent(event => { void this.nativeEvent(event).catch(e => this.fail(e)); }); }
  get preferences() { return this.prefs; }
  set preferences(value: Preferences) {
    const previous = this.prefs; this.prefs = value;
    if (value.transcribeLocale !== previous.transcribeLocale) this.transcription = undefined;
    if (value.transcribe !== previous.transcribe) for (const call of this.snapshot.calls) { if (!value.transcribe) this.stopTranscript(call.id); else if (call.answered || (this.isNative(call.id) && call.direction === 'outgoing')) void this.transcribe(call.id); }
  }
  onHistory?: (item: HistoryItem, demo: boolean) => void;
  onMessage?: (message: ChatMessage) => void;
  onRecording?: () => void;
  onIncoming?: (call: Call) => void;
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private emit(patch: Partial<PhoneSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; this.listeners.forEach(fn => fn()); window.desktop?.setCallActive(this.snapshot.calls.length > 0); }
  log(level: LogEntry['level'], text: string, accountId?: string, details: Partial<LogEntry> = {}) { this.emit({ log: [...this.snapshot.log.slice(-1999), { id: ++this.logId, time: Date.now(), level, text, accountId, ...details }] }); }
  /** Places an entry by its time (transcribed speech arrives a moment after it was said), replacing entries that match `replace`. */
  private insertLog(entry: Omit<LogEntry, 'id'>, replace?: (e: LogEntry) => boolean) {
    const previous = replace && this.snapshot.log.find(replace);
    const log = replace ? this.snapshot.log.filter(e => !replace(e)) : [...this.snapshot.log];
    const item: LogEntry = { ...entry, id: previous && entry.partial ? previous.id : ++this.logId };
    let i = log.length; while (i > 0 && log[i - 1].time > item.time) i--;
    log.splice(i, 0, item); this.emit({ log: log.slice(-2000) });
  }
  clearLog = () => this.emit({ log: [] });
  private connection(id: string, state: PhoneSnapshot['connections'][string]['state'], detail?: string) {
    const previous = this.snapshot.connections[id];
    this.emit({ connections: { ...this.snapshot.connections, [id]: { state, detail } } });
    if (previous?.state === state && previous.detail === detail) return;
    if (state === 'registered') this.log('success', 'Registered', id);
    else if (state === 'error') this.log('error', `Registration failed${detail ? `: ${detail}` : ''}`, id);
    else if (state === 'offline' && previous && previous.state !== 'offline') this.log('info', detail || 'Unregistered', id);
  }
  /** Shows an account as offline with a reason, without contacting the server (for example, when its password is not stored). */
  setOffline(id: string, detail: string) { this.emit({ connections: { ...this.snapshot.connections, [id]: { state: 'offline', detail } } }); }
  clearError = () => this.emit({ error: null });
  fail(error: unknown) { const text = errorText(error); this.emit({ error: text }); this.log('error', text); }
  private update(id: string, patch: Partial<Call>) { this.emit({ calls: this.snapshot.calls.map(c => c.id === id ? { ...c, ...patch } : c) }); }
  private call(id: string) { const call = this.snapshot.calls.find(c => c.id === id); if (!call) throw new Error('This call has ended.'); return call; }
  private handler(id: string) { return this.sessions.get(id)?.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined; }
  private constraints(video = false) { return { audio: { deviceId: this.preferences.input ? { exact: this.preferences.input } : undefined, echoCancellation: this.preferences.echoCancellation, noiseSuppression: this.preferences.noiseSuppression, autoGainControl: true }, video: video ? { deviceId: this.preferences.camera ? { exact: this.preferences.camera } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } } : false }; }
  private target(number: string, account: Account) { const uri = UserAgent.makeURI(dialTarget(number, account.domain)); if (!uri) throw new Error('The SIP address is invalid.'); return uri; }

  async connect(account: Account, credentials: Credentials) {
    if (this.snapshot.calls.some(c => c.accountId === account.id)) throw new Error('End this account’s calls before reconnecting.');
    await this.disconnect(account.id);
    this.connection(account.id, 'connecting');
    this.log('info', `Registering sip:${account.username}@${account.domain}${account.transport === 'wss' ? ` via ${account.server}` : `:${account.port};transport=${account.transport}`}`, account.id);
    try {
      if (account.transport !== 'wss') {
        if (!window.desktop) throw new Error('Standard SIP accounts require the desktop app.');
        this.nativeAccounts.set(account.id, account);
        await window.desktop.sipConnect(account, credentials);
        return;
      }
      if (!/^wss:\/\//i.test(account.server)) throw new Error('Enter the provider’s secure WebSocket URL (wss://host/path).');
      const uri = this.target(account.username, account);
      const iceServers: RTCIceServer[] = [];
      if (account.stun) iceServers.push({ urls: account.stun });
      if (account.turn) iceServers.push({ urls: account.turn, username: account.turnUser, credential: credentials.turnPassword });
      const ua = new UserAgent({ uri, displayName: account.displayName, authorizationUsername: account.authUser || account.username, authorizationPassword: credentials.password, transportOptions: { server: account.server, connectionTimeout: 10, traceSip: false }, logBuiltinEnabled: false, logConfiguration: false, sessionDescriptionHandlerFactoryOptions: { peerConnectionConfiguration: { iceServers } }, delegate: {
        onInvite: invitation => { void this.incoming(account, invitation).catch(e => this.fail(e)); },
        onMessage: message => { void message.accept(); this.onMessage?.({ id: uid(), peer: message.request.from.uri.user || message.request.from.uri.toString(), body: message.request.body, incoming: true, time: Date.now(), status: 'received', accountId: account.id }); },
        onDisconnect: () => this.connection(account.id, 'error', 'Connection lost. Re-register the account.')
      } });
      const registerer = new Registerer(ua, { expires: 300, logConfiguration: false });
      const client: Client = { ua, registerer, account };
      this.clients.set(account.id, client);
      registerer.stateChange.addListener(state => {
        if (this.clients.get(account.id) !== client) return;
        if (state === RegistererState.Registered) { clearTimeout(client.timer); this.connection(account.id, 'registered'); this.subscribeVoicemail(client); }
        else if (state === RegistererState.Unregistered) this.connection(account.id, 'offline', 'Registration ended.');
      });
      client.timer = setTimeout(() => { if (this.snapshot.connections[account.id]?.state === 'connecting') { this.connection(account.id, 'error', 'No response from the server. Check the WebSocket URL and credentials.'); void this.disposeClient(account.id); } }, 18000);
      await ua.start();
      await registerer.register({ requestDelegate: { onReject: response => { clearTimeout(client.timer); this.connection(account.id, 'error', `${response.message.statusCode} ${response.message.reasonPhrase || 'Registration rejected'}`.trim()); } } });
    } catch (error) { this.connection(account.id, 'error', errorText(error)); await this.disposeClient(account.id); throw error; }
  }
  private subscribeVoicemail(client: Client) {
    if (client.subscriber) return;
    const subscriber = new Subscriber(client.ua, this.target(client.account.username, client.account), 'message-summary', { expires: 3600 });
    subscriber.delegate = { onNotify: notification => { void notification.accept(); const match = notification.request.body.match(/Voice-Message:\s*(\d+)/i); const waiting = /Messages-Waiting:\s*yes/i.test(notification.request.body); this.emit({ voicemail: { ...this.snapshot.voicemail, [client.account.id]: match ? Number(match[1]) : waiting ? 1 : 0 } }); } };
    client.subscriber = subscriber;
    void subscriber.subscribe().catch(() => { /* Voicemail subscriptions are optional at the provider. */ });
  }
  private async disposeClient(id: string) { const c = this.clients.get(id); if (!c) return; this.clients.delete(id); clearTimeout(c.timer); await c.subscriber?.dispose().catch(() => {}); await c.registerer.dispose().catch(() => {}); await c.ua.stop().catch(() => {}); }
  async disconnect(id: string) { if (this.snapshot.calls.some(c => c.accountId === id)) throw new Error('End this account’s calls before disconnecting.'); if (this.nativeAccounts.has(id)) { await window.desktop?.sipDisconnect(id); this.nativeAccounts.delete(id); } await this.disposeClient(id); this.connection(id, 'offline'); }

  private isNative(id: string) { return id.startsWith('native:'); }
  private nativeAction(action: string, id: string, extra: { to?: string; other?: string; token?: string } = {}) { if (!window.desktop) throw new Error('The desktop SIP engine is unavailable.'); return window.desktop.sipAction({ action, call: id.replace(/^native:/, ''), ...extra }); }
  private async nativeEvent(event: NativeEvent) {
    if (event.kind === 'transcript' && event.call && event.transcript) { this.transcriptEvent(event.call, event.transcript); return; }
    if (event.kind === 'event' && event.type === 'CALL_DTMF_START' && event.id && event.param) { const id = `native:${event.id}`; this.log('info', `Received DTMF ${event.param}`, event.accountId, { kind: 'dtmf', side: 'remote', callId: id, speaker: this.snapshot.calls.find(c => c.id === id)?.name, digit: event.param, detail: 'out-of-band' }); return; }
    if (event.kind === 'event' && event.type && !quietEvents.has(event.type)) {
      const label = eventLabels[event.type] || event.type; const closed = event.type === 'CALL_CLOSED';
      const text = ['CALL_INCOMING', 'CALL_OUTGOING'].includes(event.type) && event.peeruri ? `${label} ${event.type === 'CALL_INCOMING' ? 'from' : 'to'} ${event.peeruri}` : `${label}${event.param ? ` · ${event.param}` : ''}`;
      this.log(closed && failure(event.param) || event.type === 'CALL_TRANSFER_FAILED' || event.type === 'AUDIO_ERROR' ? 'warning' : event.type === 'CALL_ESTABLISHED' || event.type === 'CALL_RTPESTAB' ? 'success' : 'info', text, event.accountId);
    }
    if (event.kind === 'connection' && event.accountId && event.state) { this.connection(event.accountId, event.state, event.detail); if (event.state === 'error' && event.detail?.includes('engine stopped')) for (const c of this.snapshot.calls.filter(c => c.accountId === event.accountId)) this.finish(c.id); return; }
    if (event.kind === 'message' && event.accountId) { this.onMessage?.({ id: uid(), peer: (event.peer || '').replace(/^sip:/, '').split('@')[0], body: event.body || '', incoming: true, time: Date.now(), status: 'received', accountId: event.accountId }); return; }
    if (event.kind === 'message-status' && event.token) { const pending = this.nativeMessages.get(event.token); if (pending) { clearTimeout(pending.timer); this.nativeMessages.delete(event.token); if (event.status && event.status >= 200 && event.status < 300) pending.resolve(); else pending.reject(new Error(`Message rejected by provider (${event.status}).`)); } return; }
    if (event.kind === 'recording' && event.token) { const meta = this.nativeRecordings.get(event.token); if (!meta || !window.desktop) return; const bytes = await window.desktop.sipRecording(event.token); await recordings.save({ id: event.token, name: meta.call.name, number: meta.call.number, time: meta.started, duration: Math.round((Date.now() - meta.started) / 1000), blob: new Blob([bytes], { type: 'audio/wav' }) }); this.nativeRecordings.delete(event.token); this.update(meta.call.id, { recording: false }); this.onRecording?.(); return; }
    if (event.kind === 'recording-error') { if (event.token) { const meta = this.nativeRecordings.get(event.token); if (meta) this.update(meta.call.id, { recording: false }); this.nativeRecordings.delete(event.token); } throw new Error('The recording could not be saved. Check available disk space.'); }
    if (event.type === 'MWI_NOTIFY' && event.accountId) { const count = Number(event.param?.match(/Voice-Message:\s*(\d+)/i)?.[1] || (/Messages-Waiting:\s*yes/i.test(event.param || '') ? 1 : 0)); this.emit({ voicemail: { ...this.snapshot.voicemail, [event.accountId]: count } }); return; }
    if (!event.id || !event.accountId) return;
    const id = `native:${event.id}`; const account = this.nativeAccounts.get(event.accountId);
    if (['CALL_INCOMING', 'CALL_OUTGOING', 'CALL_RINGING', 'CALL_PROGRESS'].includes(event.type || '') && !this.snapshot.calls.some(c => c.id === id)) {
      const incoming = event.direction === 'incoming'; const number = (event.peeruri || '').replace(/^sips?:/, '').split('@')[0];
      if (incoming && (this.preferences.dnd || this.snapshot.calls.length >= 5)) { this.log('info', this.preferences.dnd ? 'Declined incoming call (Do Not Disturb)' : 'Declined incoming call (call limit reached)', event.accountId); await this.nativeAction('end', id); return; }
      if (incoming && this.preferences.forward && account) { this.log('info', `Forwarding incoming call to ${this.preferences.forward}`, event.accountId); await this.nativeAction('forward', id, { to: dialTarget(this.preferences.forward, `${account.domain}:${account.port}`) }); return; }
      const call: Call = { id, accountId: event.accountId, name: incoming ? event.peerdisplayname || number : this.nativeDialing?.name || number, number, uri: event.peeruri, direction: incoming ? 'incoming' : 'outgoing', state: incoming ? 'ringing' : 'dialing', started: Date.now(), muted: false, video: false, cameraOff: false, recording: false, conference: false, demo: false, dtmf: '' };
      this.emit({ calls: [...this.snapshot.calls, call] });
      if (incoming) { this.onIncoming?.(call); if (this.preferences.autoAnswer && this.snapshot.calls.length === 1) await this.answer(id); }
      // Outgoing calls are transcribed from the start, so early-media announcements are captured too.
      else void this.transcribe(id);
    }
    if ((event.type === 'CALL_RINGING' || event.type === 'CALL_PROGRESS') && this.snapshot.calls.some(c => c.id === id && c.direction === 'outgoing')) this.update(id, { progress: event.type === 'CALL_RINGING' ? 'ringing' : 'early' });
    if (event.type === 'CALL_ESTABLISHED' && this.snapshot.calls.some(c => c.id === id)) this.update(id, { state: 'active', answered: this.call(id).answered ?? Date.now() });
    if (event.type === 'CALL_CLOSED') this.finish(id, event.param);
    if (event.type === 'CALL_TRANSFER_FAILED') this.fail(new Error(`Transfer failed: ${event.param || 'The provider declined the request.'}`));
  }

  async dial(number: string, name: string, accountId: string, demo: boolean, video = false) {
    if (this.snapshot.calls.length >= 5) throw new Error('You can have up to five simultaneous calls.');
    if (!number.trim()) throw new Error('Enter a number to call.');
    if (!demo && this.nativeAccounts.has(accountId)) {
      if (video) throw new Error('Video is available on WebRTC accounts. This SIP line supports audio calls.');
      if (this.snapshot.connections[accountId]?.state !== 'registered') throw new Error('Register this account before calling.');
      if (this.nativeDialing) throw new Error('A call is already being started.');
      for (const c of this.snapshot.calls.filter(c => c.state === 'active')) await this.hold(c.id, true);
      const a = this.nativeAccounts.get(accountId)!; this.nativeDialing = { name, number, accountId };
      try {
        const uri = dialTarget(number, `${a.domain}:${a.port}`);
        const nativeId = await window.desktop!.sipAction({ action: 'dial', accountId, to: uri });
        const id = `native:${nativeId}`;
        if (!this.snapshot.calls.some(c => c.id === id)) this.emit({ calls: [...this.snapshot.calls, { id, accountId, name: name || number, number, uri, direction: 'outgoing', state: 'dialing', started: Date.now(), muted: false, video: false, cameraOff: false, recording: false, conference: false, demo: false, dtmf: '' }] });
        void this.transcribe(id);
        return id;
      } finally { this.nativeDialing = undefined; }
    }
    let client: Client | undefined;
    if (!demo) { client = this.clients.get(accountId); if (!client || this.snapshot.connections[accountId]?.state !== 'registered') throw new Error('Register a SIP account before calling.'); this.target(number, client.account); }
    for (const call of this.snapshot.calls.filter(c => c.state === 'active')) await this.hold(call.id, true);
    const uri = client ? this.target(number, client.account).toString() : `sip:${number}@demo`;
    const call: Call = { id: uid(), accountId: demo ? 'demo' : accountId, name: name || number, number, uri, direction: 'outgoing', state: 'dialing', started: Date.now(), muted: false, video, cameraOff: false, recording: false, conference: false, demo, dtmf: '' };
    this.emit({ calls: [...this.snapshot.calls, call] });
    if (demo) { this.demoTimers.set(call.id, setTimeout(() => { this.update(call.id, { state: 'active', answered: Date.now() }); }, 1400)); return call.id; }
    try {
      const session = new Inviter(client!.ua, this.target(number, client!.account), { sessionDescriptionHandlerOptions: { constraints: this.constraints(video) } });
      this.track(call.id, session);
      this.log('info', `${video ? 'Video call' : 'Outgoing call'} to ${uri}`, accountId);
      await session.invite({ requestDelegate: { onProgress: response => { const code = response.message.statusCode; if (code !== 180 && code !== 183) return; this.log('info', code === 180 ? 'Ringing' : 'Session progress (early media)', accountId); if (this.snapshot.calls.some(c => c.id === call.id)) this.update(call.id, { progress: code === 180 ? 'ringing' : 'early' }); }, onReject: response => { const reason = `${response.message.statusCode} ${response.message.reasonPhrase || ''}`.trim(); if (this.snapshot.calls.some(c => c.id === call.id)) this.update(call.id, { reason }); this.log('warning', `Call rejected · ${reason}`, accountId); } } });
      return call.id;
    } catch (error) { this.finish(call.id); throw error; }
  }
  private async incoming(account: Account, invitation: Invitation) {
    const from = invitation.remoteIdentity.uri.toString();
    if (this.preferences.dnd || this.snapshot.calls.length >= 5) { this.log('info', `Declined incoming call from ${from} (${this.preferences.dnd ? 'Do Not Disturb' : 'call limit reached'})`, account.id); await invitation.reject({ statusCode: 486 }); return; }
    if (this.preferences.forward) { this.log('info', `Forwarding incoming call from ${from} to ${this.preferences.forward}`, account.id); await invitation.reject({ statusCode: 302, extraHeaders: [`Contact: <${this.target(this.preferences.forward, account).toString()}>`] }); return; }
    const call: Call = { id: uid(), accountId: account.id, name: invitation.remoteIdentity.displayName || invitation.remoteIdentity.uri.user || 'Unknown caller', number: invitation.remoteIdentity.uri.user || from, uri: from, direction: 'incoming', state: 'ringing', started: Date.now(), muted: false, video: /m=video/.test(invitation.request.body), cameraOff: false, recording: false, conference: false, demo: false, dtmf: '' };
    this.log('info', `Incoming ${call.video ? 'video ' : ''}call from ${from}`, account.id);
    this.emit({ calls: [...this.snapshot.calls, call] }); this.track(call.id, invitation); this.onIncoming?.(call);
    if (this.preferences.autoAnswer && !call.video && this.snapshot.calls.length === 1) await this.answer(call.id, false);
  }
  simulateIncoming() { const call: Call = { id: uid(), accountId: 'demo', name: 'Test caller', number: '101', uri: 'sip:101@demo', direction: 'incoming', state: 'ringing', started: Date.now(), muted: false, video: false, cameraOff: false, recording: false, conference: false, demo: true, dtmf: '' }; if (this.preferences.dnd) return; this.emit({ calls: [...this.snapshot.calls, call] }); this.onIncoming?.(call); this.demoTimers.set(call.id, setTimeout(() => this.finish(call.id), 30000)); }
  private track(id: string, session: Session) {
    this.sessions.set(id, session);
    session.delegate = { onRefer: referral => { void referral.reject(); }, onSessionDescriptionHandler: () => this.attach(id), onInfo: info => {
      void info.accept();
      const digit = info.request.body.match(/^Signal\s*=\s*([0-9*#A-D])/im)?.[1]; const call = this.snapshot.calls.find(c => c.id === id);
      if (digit && call) this.log('info', `Received DTMF ${digit}`, call.accountId, { kind: 'dtmf', side: 'remote', callId: id, speaker: call.name, digit, detail: 'SIP INFO' });
    } };
    session.stateChange.addListener(state => {
      const accountId = this.snapshot.calls.find(c => c.id === id)?.accountId;
      if (state === SessionState.Established) { this.update(id, { state: 'active', answered: this.call(id).answered ?? Date.now() }); this.attach(id); this.log('success', 'Call established', accountId); void this.transcribe(id); }
      if (state === SessionState.Terminated) { this.log('info', 'Call closed', accountId); this.finish(id); }
    });
  }
  private attach(id: string) {
    const handler = this.handler(id); if (!handler) return;
    let audio = this.audio.get(id); if (!audio) { audio = document.createElement('audio'); audio.autoplay = true; this.audio.set(id, audio); }
    audio.srcObject = handler.remoteMediaStream;
    if (this.preferences.output) void audio.setSinkId?.(this.preferences.output).catch(e => this.fail(e));
    const play = () => { void audio!.play().catch(() => {}); }; handler.remoteMediaStream.addEventListener('addtrack', play); play();
  }
  getMedia(id: string) { return { local: this.handler(id)?.localMediaStream, remote: this.handler(id)?.remoteMediaStream }; }
  async answer(id: string, video = false) { const call = this.call(id); this.log('info', 'Answering', call.accountId); for (const other of this.snapshot.calls.filter(c => c.id !== id && c.state === 'active')) await this.hold(other.id, true); if (call.demo) { clearTimeout(this.demoTimers.get(id)); this.update(id, { state: 'active', answered: Date.now() }); return; } if (this.isNative(id)) { void this.transcribe(id); await this.nativeAction('answer', id); return; } const session = this.sessions.get(id); if (session instanceof Invitation) { this.update(id, { video }); await session.accept({ sessionDescriptionHandlerOptions: { constraints: this.constraints(video) } }); } }
  async end(id: string) {
    const call = this.call(id); this.log('info', call.state === 'ringing' && call.direction === 'incoming' ? 'Declined' : call.answered ? 'Hung up' : 'Cancelled', call.accountId);
    if (call.demo) { this.finish(id); return; } if (this.isNative(id)) { await this.nativeAction('end', id); return; }
    const session = this.sessions.get(id); if (!session) return;
    switch (session.state) {
      case SessionState.Initial: case SessionState.Establishing: if (session instanceof Inviter) await session.cancel(); else if (session instanceof Invitation) await session.reject(); break;
      case SessionState.Established: await session.bye(); break;
      default: break;
    }
  }
  private finish(id: string, closeReason?: string) {
    const call = this.snapshot.calls.find(c => c.id === id); if (!call) return;
    const account = this.clients.get(call.accountId)?.account || this.nativeAccounts.get(call.accountId); const reason = closeReason || call.reason;
    if (call.conference) void this.splitConference(this.snapshot.calls.find(c => c.id !== id)?.id).catch(e => this.fail(e));
    this.stopRecording(id); this.stopTranscript(id); clearTimeout(this.demoTimers.get(id)); this.demoTimers.delete(id);
    const audio = this.audio.get(id); if (audio) { audio.pause(); audio.srcObject = null; } this.audio.delete(id); this.sessions.delete(id);
    this.onHistory?.({ id, name: call.name, number: call.number, direction: call.direction === 'incoming' && !call.answered ? 'missed' : call.direction, time: call.started, duration: call.answered ? Math.round((Date.now() - call.answered) / 1000) : 0, account: call.demo ? 'Demo line' : account ? accountLabel(account) : 'SIP account', accountId: call.accountId, video: call.video, ...(reason ? { reason } : {}) }, call.demo);
    this.emit({ calls: this.snapshot.calls.filter(c => c.id !== id) });
  }
  async mute(id: string) { const call = this.call(id); this.log('info', call.muted ? 'Unmuted' : 'Muted', call.accountId); const targets = call.conference ? this.snapshot.calls.filter(c => c.conference) : [call]; for (const target of targets) { if (this.isNative(target.id)) await this.nativeAction(call.muted ? 'unmute' : 'mute', target.id); this.handler(target.id)?.localMediaStream.getAudioTracks().forEach(track => { track.enabled = call.muted; }); this.update(target.id, { muted: !call.muted }); } }
  camera(id: string) { const call = this.call(id); this.handler(id)?.localMediaStream.getVideoTracks().forEach(track => { track.enabled = call.cameraOff; }); this.update(id, { cameraOff: !call.cameraOff }); }
  async hold(id: string, held: boolean) {
    const call = this.call(id); if (call.conference) await this.splitConference(id);
    this.log('info', held ? `Hold · ${call.name}` : `Resume · ${call.name}`, call.accountId);
    if (this.isNative(id)) { await this.nativeAction(held ? 'hold' : 'resume', id); this.update(id, { state: held ? 'held' : 'active' }); return; }
    if (!call.demo) { const session = this.sessions.get(id); if (!session || session.state !== SessionState.Established) throw new Error('Wait for the call to connect.'); await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('The provider did not confirm hold.')), 10000); void session.invite({ sessionDescriptionHandlerOptions: { hold: held } as Web.SessionDescriptionHandlerOptions, requestDelegate: { onAccept: () => { clearTimeout(timer); resolve(); }, onReject: () => { clearTimeout(timer); reject(new Error('The provider declined the hold request.')); } } }).catch(e => { clearTimeout(timer); reject(e); }); }); }
    this.update(id, { state: held ? 'held' : 'active' });
  }
  async dtmf(id: string, digit: string) {
    if (!/^[0-9*#]$/.test(digit)) return; const call = this.call(id); this.update(id, { dtmf: (call.dtmf + digit).slice(-64) });
    const sender = this.handler(id)?.peerConnection?.getSenders().find(s => s.track?.kind === 'audio'); const rtp = this.isNative(id) || !!sender?.dtmf?.canInsertDTMF;
    this.log('info', `Sent DTMF ${digit}`, call.accountId, { kind: 'dtmf', side: 'local', callId: id, speaker: 'You', digit, detail: call.demo ? undefined : rtp ? 'RFC 4733' : 'SIP INFO' });
    if (call.demo) return; if (this.isNative(id)) { await this.nativeAction('dtmf', id, { to: digit }); return; }
    if (sender?.dtmf?.canInsertDTMF) sender.dtmf.insertDTMF(digit, 160, 70); else await this.sessions.get(id)?.info({ requestOptions: { body: { contentDisposition: 'render', contentType: 'application/dtmf-relay', content: `Signal=${digit}\r\nDuration=160` } } });
  }
  async transfer(id: string, target: string, attendedId?: string) {
    const call = this.call(id); this.log('info', attendedId ? `Attended transfer of ${call.name}` : `Transfer of ${call.name} to ${target}`, call.accountId);
    if (call.demo) { this.finish(id); if (attendedId) this.finish(attendedId); return; }
    if (this.isNative(id)) { if (attendedId && !this.isNative(attendedId)) throw new Error('Both calls must use the same connection type.'); await this.nativeAction(attendedId ? 'attended' : 'transfer', id, { to: dialTarget(target || call.number, `${this.nativeAccounts.get(call.accountId)!.domain}:${this.nativeAccounts.get(call.accountId)!.port}`), other: attendedId?.replace(/^native:/, '') }); return; }
    const session = this.sessions.get(id); const client = this.clients.get(call.accountId); if (!session || !client) return;
    const uri = attendedId ? this.sessions.get(attendedId) : this.target(target, client.account); if (!uri) throw new Error('The consultation call has ended.');
    await new Promise<void>((resolve, reject) => { let done = false; const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(); }; const timer = setTimeout(() => finish(new Error('The provider has not confirmed the transfer. Your call is still open.')), 20000);
      void session.refer(uri, { requestDelegate: { onReject: () => finish(new Error('The provider declined the transfer.')) }, onNotify: notification => { void notification.accept(); const status = Number(notification.request.body.match(/SIP\/2.0\s+(\d+)/)?.[1]); if (status >= 200 && status < 300) { finish(); void this.end(id); if (attendedId) void this.end(attendedId); } else if (status >= 300) finish(new Error(`Transfer failed (${status}).`)); } }).catch(e => finish(e));
    });
  }
  async merge() {
    const calls = this.snapshot.calls.filter(c => c.state === 'active' || c.state === 'held'); if (calls.length < 2) throw new Error('Connect a second call to start a conference.');
    this.log('info', `Merging ${calls.length} calls into a conference`);
    if (calls.some(c => this.isNative(c.id))) { if (!calls.every(c => this.isNative(c.id))) throw new Error('Merge calls that use the same SIP connection type.'); await window.desktop!.sipAction({ action: 'merge' }); this.emit({ calls: this.snapshot.calls.map(c => ({ ...c, state: 'active', conference: true })) }); return; }
    if (calls.some(c => c.video)) throw new Error('Local conferences support audio calls.');
    for (const c of calls) if (c.state === 'held') await this.hold(c.id, false);
    if (calls.every(c => c.demo)) { this.emit({ calls: this.snapshot.calls.map(c => ({ ...c, conference: true })) }); return; }
    await this.splitConference(); const context = new AudioContext(); this.conferenceContext = context; await context.resume();
    try {
      for (const call of calls) {
        const handler = this.handler(call.id); const sender = handler?.peerConnection?.getSenders().find(s => s.track?.kind === 'audio'); if (!handler || !sender?.track) throw new Error('Audio is not ready for conferencing.');
        this.conferenceOriginals.set(call.id, sender.track); const destination = context.createMediaStreamDestination();
        context.createMediaStreamSource(handler.localMediaStream).connect(destination);
        for (const other of calls.filter(c => c.id !== call.id)) { const stream = this.handler(other.id)?.remoteMediaStream; if (stream?.getAudioTracks().length) context.createMediaStreamSource(stream).connect(destination); }
        await sender.replaceTrack(destination.stream.getAudioTracks()[0]);
      }
      this.emit({ calls: this.snapshot.calls.map(c => calls.some(x => x.id === c.id) ? { ...c, conference: true } : c) });
    } catch (error) { await this.splitConference(); throw error; }
  }
  async splitConference(focusId?: string) { const members = this.snapshot.calls.filter(c => c.conference); if (members.some(c => this.isNative(c.id))) await window.desktop!.sipAction({ action: 'split' }); for (const [id, track] of this.conferenceOriginals) { const sender = this.handler(id)?.peerConnection?.getSenders().find(s => s.track?.kind === 'audio'); await sender?.replaceTrack(track).catch(() => {}); } this.conferenceOriginals.clear(); await this.conferenceContext?.close(); this.conferenceContext = undefined; this.emit({ calls: this.snapshot.calls.map(c => ({ ...c, conference: false })) }); const focus = focusId || members[0]?.id; for (const c of members) if (c.id !== focus && this.snapshot.calls.some(x => x.id === c.id && x.state === 'active')) await this.hold(c.id, true); }
  async record(id: string) {
    const call = this.call(id); if (this.isNative(id)) { if (call.recording) { await this.nativeAction('record-stop', id); this.update(id, { recording: false }); this.log('info', 'Recording stopped', call.accountId); return; } const token = uid(); this.nativeRecordings.set(token, { call, started: Date.now() }); try { await this.nativeAction('record', id, { token }); this.update(id, { recording: true }); this.log('info', 'Recording started', call.accountId); } catch (e) { this.nativeRecordings.delete(token); throw e; } return; } if (call.recording) { this.stopRecording(id); this.log('info', 'Recording stopped', call.accountId); return; } if (call.demo) throw new Error('Recordings are available during a connected live call.');
    const handler = this.handler(id); if (!handler) throw new Error('Call audio is not ready.');
    const context = new AudioContext(); await context.resume(); const destination = context.createMediaStreamDestination();
    for (const stream of [handler.localMediaStream, handler.remoteMediaStream]) if (stream.getAudioTracks().length) context.createMediaStreamSource(stream).connect(destination);
    const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' }); const chunks: Blob[] = []; const started = Date.now();
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => { const blob = new Blob(chunks, { type: recorder.mimeType }); void recordings.save({ id: uid(), name: call.name, number: call.number, time: started, duration: Math.round((Date.now() - started) / 1000), blob }).then(() => this.onRecording?.()).catch(e => this.fail(e)); void context.close(); destination.stream.getTracks().forEach(t => t.stop()); };
    recorder.start(1000); this.recorders.set(id, { recorder, context, started }); this.update(id, { recording: true }); this.log('info', 'Recording started', call.accountId);
  }
  private stopRecording(id: string) { const record = this.recorders.get(id); if (record && record.recorder.state !== 'inactive') record.recorder.stop(); this.recorders.delete(id); this.update(id, { recording: false }); }
  async sendMessage(accountId: string, peer: string, body: string) {
    if (this.nativeAccounts.has(accountId)) { const account = this.nativeAccounts.get(accountId)!; if (this.snapshot.connections[accountId]?.state !== 'registered') throw new Error('Connect this account first.'); const token = uid(); await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { this.nativeMessages.delete(token); reject(new Error('Message delivery was not confirmed.')); }, 18000); this.nativeMessages.set(token, { resolve, reject, timer }); void window.desktop!.sipAction({ action: 'message', accountId, to: dialTarget(peer, `${account.domain}:${account.port}`), body, token }).catch(e => { clearTimeout(timer); this.nativeMessages.delete(token); reject(e); }); }); return; }
    const client = this.clients.get(accountId); if (!client || this.snapshot.connections[accountId]?.state !== 'registered') throw new Error('Connect your SIP account before sending a message.');
    const messager = new Messager(client.ua, this.target(peer, client.account), body, 'text/plain');
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Message delivery was not confirmed.')), 15000); void messager.message({ requestDelegate: { onAccept: () => { clearTimeout(timer); resolve(); }, onReject: response => { clearTimeout(timer); reject(new Error(`Message rejected (${response.message.statusCode}). Your provider must support SIP messaging.`)); } } }).catch(e => { clearTimeout(timer); reject(e); }); });
  }
  async setOutput(id: string) { for (const audio of this.audio.values()) await audio.setSinkId?.(id); }

  /** Whether this computer can transcribe, for the current language. Checked once and reused. */
  transcriptionInfo(refresh = false) {
    if (!window.desktop?.transcriptionInfo) return Promise.resolve<TranscriptionInfo>({ available: false, reason: 'Live transcription requires the desktop app.', locales: [] });
    if (refresh || !this.transcription) this.transcription = window.desktop.transcriptionInfo(this.prefs.transcribeLocale).catch(e => ({ available: false, reason: errorText(e), locales: [] }));
    return this.transcription;
  }
  /** Starts transcribing a call on this computer: native calls stream from the SIP engine, WebRTC calls from the page's audio. */
  private async transcribe(id: string) {
    const call = this.snapshot.calls.find(c => c.id === id); const native = this.isNative(id);
    if (!call || call.demo || !this.prefs.transcribe || !window.desktop?.transcribeStart || this.transcripts.has(id) || (!native && !this.handler(id))) return;
    const transcript: Transcript = { accountId: call.accountId, speaker: call.name, active: true }; this.transcripts.set(id, transcript);
    try {
      // Settings explains why transcription is unavailable; the log stays quiet about it.
      if (!(await this.transcriptionInfo()).available) { this.transcripts.delete(id); return; }
      await window.desktop.transcribeStart(id, this.prefs.transcribeLocale);
      if (!native) transcript.stopCapture = await this.captureAudio(id);
      if (!transcript.active || !this.snapshot.calls.some(c => c.id === id)) { transcript.active = true; this.stopTranscript(id); return; }
      this.update(id, { transcribing: true });
    } catch (error) {
      this.transcripts.delete(id); transcript.stopCapture?.(); if (window.desktop.transcribeStop) void window.desktop.transcribeStop(id).catch(() => {});
      // A call that failed at once takes its audio with it; that is not a transcription problem. Real failures are reported once, not on every call.
      if (!this.snapshot.calls.some(c => c.id === id) || this.transcriptionNoticed) return;
      this.transcriptionNoticed = true; this.log('warning', `Transcription off · ${errorText(error)}`, call.accountId);
    }
  }
  private stopTranscript(id: string) {
    const transcript = this.transcripts.get(id); if (!transcript?.active) return;
    transcript.active = false; transcript.stopCapture?.(); void window.desktop?.transcribeStop?.(id).catch(() => {});
    if (this.snapshot.calls.some(c => c.id === id)) this.update(id, { transcribing: false });
  }
  /** Streams a WebRTC call's microphone and remote audio to the transcription helper as 16-bit PCM. */
  private async captureAudio(id: string) {
    const handler = this.handler(id); if (!handler) throw new Error('Call audio is not ready.');
    // Chromium can collect audio nodes that nothing in script references, silently ending the capture; keep them until stopped.
    const context = new AudioContext(); const nodes: AudioNode[] = [];
    try {
      await context.audioWorklet.addModule(new URL('transcribe-worklet.js', document.baseURI).href);
      const sink = context.createGain(); sink.gain.value = 0; sink.connect(context.destination); nodes.push(sink);
      [handler.localMediaStream, handler.remoteMediaStream].forEach((stream, side) => {
        if (!stream.getAudioTracks().length) return;
        const node = new AudioWorkletNode(context, 'dialdev-capture'), source = context.createMediaStreamSource(stream);
        node.port.onmessage = event => window.desktop?.transcribeAudio(id, side as 0 | 1, context.sampleRate, new Uint8Array(event.data as ArrayBuffer));
        source.connect(node).connect(sink); nodes.push(source, node);
      });
    } catch (error) { void context.close(); throw error; }
    return () => { nodes.forEach(node => node.disconnect()); nodes.length = 0; void context.close(); };
  }
  private transcriptEvent(id: string, t: TranscriptEvent) {
    const transcript = this.transcripts.get(id); if (!transcript) return;
    const call = this.snapshot.calls.find(c => c.id === id); const remote = call?.name || transcript.speaker;
    const partials = (side?: string) => (e: LogEntry) => !!e.partial && e.callId === id && (!side || e.side === side);
    if (t.type === 'end') { this.transcripts.delete(id); if (this.snapshot.log.some(partials())) this.emit({ log: this.snapshot.log.filter(e => !partials()(e)) }); return; }
    if (t.type === 'status') { this.log('info', `Transcription · ${t.message}`, transcript.accountId); return; }
    if (t.type === 'error') { this.log('warning', t.message || 'Transcription stopped.', transcript.accountId); return; }
    if (t.type === 'dtmf' && t.digit) { this.insertLog({ time: t.time ?? Date.now(), level: 'info', text: `Heard DTMF ${t.digit}`, accountId: transcript.accountId, kind: 'dtmf', side: t.side, callId: id, speaker: t.side === 'local' ? 'You' : remote, digit: t.digit, detail: 'in-band tone' }); return; }
    if (t.type !== 'text' || !t.side) return;
    const time = t.start ?? Date.now();
    // In a conference every call carries the same microphone audio; only the first member reports it.
    if (t.side === 'local' && call?.conference && this.snapshot.calls.find(c => c.conference)?.id !== id) return;
    // Without a headset the microphone also hears the other side through the speakers. Leave that echo out of "You".
    const echoes = (local: string, at: number) => (e: LogEntry) => e.kind === 'speech' && e.callId === id && e.side === 'remote' && Math.abs(e.time - at) < 5000 && repeats(local, e.text);
    if (!t.text || (t.side === 'local' && this.snapshot.log.some(echoes(t.text, time)))) { if (this.snapshot.log.some(partials(t.side))) this.emit({ log: this.snapshot.log.filter(e => !partials(t.side)(e)) }); return; }
    const echoed = (e: LogEntry) => t.side === 'remote' && e.kind === 'speech' && e.callId === id && e.side === 'local' && Math.abs(e.time - time) < 5000 && repeats(e.text, t.text!);
    this.insertLog({ time, level: 'info', text: t.text, accountId: transcript.accountId, kind: 'speech', side: t.side, callId: id, speaker: t.side === 'local' ? 'You' : remote, partial: !t.final }, e => partials(t.side)(e) || echoed(e));
  }
}
export const phone = new PhoneEngine();
