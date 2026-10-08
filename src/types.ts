export type Transport = 'udp' | 'tcp' | 'tls' | 'wss';
export type Account = { id: string; name: string; username: string; domain: string; server: string; authUser: string; displayName: string; voicemail: string; stun: string; turn: string; turnUser: string; enabled: boolean; transport: Transport; port: string; proxy: string; mediaEncryption: 'none' | 'srtp' };
export type Credentials = { password: string; turnPassword: string };
export type Contact = { id: string; name: string; number: string; email: string; company: string; favorite: boolean; color: string; group: string };
export type HistoryItem = { id: string; name: string; number: string; direction: 'incoming' | 'outgoing' | 'missed'; time: number; duration: number; account: string; accountId?: string; video: boolean; reason?: string };
export type ChatMessage = { id: string; peer: string; body: string; incoming: boolean; time: number; status: 'sent' | 'failed' | 'received' | 'sending'; accountId: string };
export type Preferences = { theme: 'light' | 'dark' | 'system'; dnd: boolean; sounds: boolean; autoAnswer: boolean; forward: string; input: string; output: string; camera: string; echoCancellation: boolean; noiseSuppression: boolean; callDetails: boolean; transcribe: boolean; transcribeLocale: string; captions: boolean; checkUpdates: boolean };
export type Recording = { id: string; name: string; number: string; time: number; duration: number; blob: Blob };
export type Call = { id: string; accountId: string; name: string; number: string; uri?: string; direction: 'incoming' | 'outgoing'; state: 'ringing' | 'dialing' | 'active' | 'held'; started: number; answered?: number; muted: boolean; video: boolean; cameraOff: boolean; recording: boolean; conference: boolean; demo: boolean; dtmf: string; reason?: string; progress?: 'ringing' | 'early'; transcribing?: boolean };
export type Connection = { state: 'offline' | 'connecting' | 'registered' | 'error'; detail?: string };
/** Activity entries. Speech and DTMF entries also name the call and which side they came from; a partial entry is live speech the recognizer may still revise. */
export type LogEntry = { id: number; time: number; level: 'info' | 'success' | 'warning' | 'error'; text: string; accountId?: string; callId?: string; kind?: 'speech' | 'dtmf'; side?: 'local' | 'remote'; speaker?: string; digit?: string; detail?: string; partial?: boolean };
/** Results from the on-device transcription helper. Times are milliseconds since the epoch. */
export type TranscriptEvent = { type: 'text' | 'dtmf' | 'started' | 'status' | 'error' | 'end'; side?: 'local' | 'remote'; final?: boolean; text?: string; start?: number; end?: number; digit?: string; time?: number; engine?: string; locale?: string; language?: string; message?: string };
export type TranscriptionInfo = { available: boolean; reason?: string; engine?: string; locale?: string; language?: string; installed?: boolean; locales: { id: string; name: string }[] };
/** The main process's software update state. `reason` says why this copy can't install an available update itself. */
export type UpdateState = { status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error'; current: string; version?: string; notes?: string; url?: string; checked?: number; progress?: number; error?: string; canInstall: boolean; reason?: string };
export type PhoneSnapshot = { calls: Call[]; connections: Record<string, Connection>; voicemail: Record<string, number>; error: string | null; log: LogEntry[] };
export type NativeEvent = { kind: string; accountId?: string; state?: Connection['state']; detail?: string; id?: string; type?: string; peer?: string; peeruri?: string; peerdisplayname?: string; direction?: string; param?: string; body?: string; token?: string; status?: number; audiodir?: string; localaudiodir?: string; call?: string; transcript?: TranscriptEvent };
export type Pane = 'history' | 'contacts' | 'keypad' | 'messages' | 'activity';
export type AppData = { version: 1; accounts: Account[]; contacts: Contact[]; history: HistoryItem[]; messages: ChatMessage[]; preferences: Preferences; selectedAccount: string; pane: Pane; recentsSeen: number };
declare global {
  const __APP_VERSION__: string;
  interface Window {
    desktop?: {
      platform: string;
      storageNamespace: string;
      sipConnect: (account: Account, secret: Credentials) => Promise<void>;
      sipDisconnect: (id: string) => Promise<void>;
      sipAction: (payload: { action: string; accountId?: string; call?: string; other?: string; to?: string; body?: string; token?: string }) => Promise<string>;
      sipRecording: (token: string) => Promise<Uint8Array<ArrayBuffer>>;
      transcriptionInfo: (locale: string) => Promise<TranscriptionInfo>;
      transcribeStart: (callId: string, locale: string) => Promise<void>;
      transcribeAudio: (callId: string, side: 0 | 1, rate: number, pcm: Uint8Array) => void;
      transcribeStop: (callId: string) => Promise<void>;
      onSipEvent: (callback: (event: NativeEvent) => void) => () => void;
      updateState: () => Promise<UpdateState>;
      updateCheck: () => Promise<UpdateState>;
      updateInstall: () => Promise<void>;
      openRelease: () => void;
      onUpdate: (callback: (state: UpdateState) => void) => () => void;
      getSecret: (id: string) => Promise<Credentials | null>;
      saveSecret: (id: string, secret: Credentials) => Promise<void>;
      deleteSecret: (id: string) => Promise<void>;
      notify: (title: string, body: string) => void;
      onDial: (callback: (uri: string) => void) => () => void;
      onNavigate: (callback: (page: string) => void) => () => void;
      setCallActive: (active: boolean) => void;
      setTheme: (theme: Preferences['theme']) => void;
      minimize: () => void;
      maximize: () => void;
      close: () => void;
    };
  }
}
