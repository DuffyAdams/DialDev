/** Capture the real renderer with fictional, deterministic QA fixtures.
 * Run: node scripts/capture-screenshots.cjs
 * Uses a temporary Electron profile, denies device permissions, and blocks external requests.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs/screenshots');

if (!process.versions.electron) {
  (async () => {
    const { createServer } = await import('vite');
    const { spawn } = require('node:child_process');
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dialdev-screenshots-'));
    const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      const env = { ...process.env, DIALDEV_CAPTURE_URL: origin, DIALDEV_CAPTURE_PROFILE: profile, TZ: 'America/Los_Angeles' };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [__filename], { cwd: root, stdio: 'inherit', env });
      const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
      process.exitCode = code ?? 1;
    } finally { await server.close(); await fs.rm(profile, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.DIALDEV_CAPTURE_PROFILE);
  app.commandLine.appendSwitch('force-device-scale-factor', '2');
  app.on('window-all-closed', () => {});
  app.whenReady().then(capture).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

  async function capture() {
    await fs.mkdir(output, { recursive: true });
    const origin = process.env.DIALDEV_CAPTURE_URL;
    const win = new BrowserWindow({ width: 760, height: 1480, show: false, frame: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.setAudioMuted(true);
    win.webContents.setZoomFactor(2);
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(origin) && !details.url.startsWith('data:') });
    });
    const js = source => win.webContents.executeJavaScript(source);
    const settle = () => js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const now = Date.UTC(2026, 9, 10, 17, 41);
    const account = (id, name, transport, username, domain) => ({ id, name, username, domain, transport,
      server: domain, port: transport === 'tls' ? '5061' : '5060', enabled: true,
      authUser: '', displayName: 'QA Lab', voicemail: '*97', stun: '', turn: '', turnUser: '', proxy: '', mediaEncryption: 'none' });
    const accounts = [account('lab', 'QA Lab', 'udp', '1001', 'pbx.example.com'),
      account('staging', 'Staging', 'tls', '2001', 'staging.example.com'),
      account('webrtc', 'WebRTC Lab', 'wss', '3001', 'rtc.example.com')];
    const contacts = [['Support IVR', '8000'], ['Alex Morgan', '1002'], ['Echo Test', '6000'],
      ['Conference Bridge', '7000'], ['Jordan Lee', '1003'], ['Voicemail', '*97']].map(([name, number], i) =>
      ({ id: `contact-${i}`, name, number, email: '', company: 'QA Lab', favorite: i < 3, color: '', group: '' }));
    const history = [
      ['Support IVR', '8000', 'outgoing', 164, 'QA Lab', '', 4],
      ['Alex Morgan', '1002', 'incoming', 312, 'QA Lab', '', 16],
      ['Echo Test', '6000', 'outgoing', 48, 'Staging', '', 27],
      ['Jordan Lee', '1003', 'missed', 0, 'QA Lab', '', 43],
      ['Conference Bridge', '7000', 'outgoing', 0, 'Staging', '486 Busy Here', 61],
      ['Support IVR', '8000', 'outgoing', 126, 'WebRTC Lab', '', 84],
      ['Alex Morgan', '1002', 'outgoing', 208, 'QA Lab', '', 112],
      ['Echo Test', '6000', 'outgoing', 35, 'QA Lab', '', 1440],
      ['Conference Bridge', '7000', 'incoming', 645, 'Staging', '', 1465]
    ].map(([name, number, direction, duration, account, reason, minutes], i) =>
      ({ id: `history-${i}`, name, number, direction, duration, account, reason, time: now - minutes * 60000, video: false }));
    const data = { version: 1, accounts, contacts, history, messages: [], selectedAccount: 'lab', pane: 'keypad', recentsSeen: now,
      preferences: { theme: 'light', sounds: false, captions: true, transcribe: true, checkUpdates: false } };
    const connections = Object.fromEntries(accounts.map(a => [a.id, { state: 'registered' }]));
    const call = { id: 'fixture-call', accountId: 'lab', name: 'Support IVR', number: '8000', uri: 'sip:8000@pbx.example.com',
      direction: 'outgoing', state: 'active', started: now - 149000, answered: now - 144000, muted: false,
      video: false, cameraOff: false, recording: false, conference: false, demo: true, dtmf: '1204#', transcribing: true };
    const events = [
      { level: 'success', text: 'Registered · sip:1001@pbx.example.com' },
      { level: 'info', text: 'INVITE · sip:8000@pbx.example.com' },
      { level: 'info', text: '180 Ringing' },
      { level: 'info', text: '183 Session Progress · early media' },
      { level: 'success', text: 'Call established · 200 OK' },
      { level: 'success', text: 'RTP media established · PCMU / 8000 Hz' },
      { kind: 'speech', side: 'remote', speaker: 'Support IVR', text: 'Welcome to the QA test line. Enter your test code, followed by pound.' },
      { kind: 'dtmf', side: 'local', speaker: 'You', digit: '1', detail: 'RFC 4733', text: 'DTMF sent: 1' },
      { kind: 'dtmf', side: 'local', speaker: 'You', digit: '2', detail: 'RFC 4733', text: 'DTMF sent: 2' },
      { kind: 'dtmf', side: 'local', speaker: 'You', digit: '0', detail: 'RFC 4733', text: 'DTMF sent: 0' },
      { kind: 'dtmf', side: 'local', speaker: 'You', digit: '4', detail: 'RFC 4733', text: 'DTMF sent: 4' },
      { kind: 'dtmf', side: 'local', speaker: 'You', digit: '#', detail: 'RFC 4733', text: 'DTMF sent: #' },
      { kind: 'speech', side: 'remote', speaker: 'Support IVR', text: 'Test code accepted. Your audio connection is working.' }
    ].map((event, i) => ({ id: i + 1, level: 'info', accountId: 'lab', callId: call.id, time: now - (13 - i) * 1000, ...event }));

    await win.loadURL(origin);
    const mounted = () => js(`new Promise(resolve => {
      const check = () => document.querySelector('.tabbar') ? setTimeout(resolve, 100) : setTimeout(check, 20);
      check();
    })`);
    await mounted();
    let sceneId = 0;
    async function scene(pane, theme, patch = {}) {
      await js('window.dialdev.emit({ calls: [] })');
      await js(`localStorage.setItem('dialdev.v1', ${JSON.stringify(JSON.stringify({ ...data, pane, preferences: { ...data.preferences, theme } }))})`);
      await win.loadURL(`${origin}?capture=${++sceneId}`);
      win.webContents.setZoomFactor(2);
      await mounted();
      await js(`(() => {
        const NativeDate = Date;
        window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [${now}])); } static now() { return ${now}; } };
        window.dialdev.emit(${JSON.stringify({ connections, calls: [], log: [], error: null, ...patch })});
      })()`);
      await settle();
      const actual = await js(`({ pane: document.querySelector('.tabbar button.selected')?.textContent, theme: document.documentElement.dataset.theme, state: window.dialdev.getSnapshot().connections.lab?.state })`);
      const labels = { keypad: 'Keypad', activity: 'Activity', history: 'Recents' };
      if (actual.pane !== labels[pane] || actual.theme !== theme || actual.state !== 'registered') throw new Error(`Unexpected scene: ${JSON.stringify(actual)}`);
    }
    async function save(name) {
      await js('document.activeElement?.blur()');
      await settle();
      const image = await win.webContents.capturePage();
      await fs.writeFile(path.join(output, `${name}.png`), image.toPNG());
      console.log(`Captured ${name}: ${image.getSize().width} × ${image.getSize().height}`);
    }
    await scene('keypad', 'light');
    await js(`for (const key of '8000') window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))`);
    await save('keypad');
    await scene('keypad', 'dark', { calls: [call], log: events });
    await save('active-call');
    await scene('activity', 'light', { calls: [call], log: events });
    await save('activity');
    await scene('history', 'light');
    await save('recents');
    await scene('keypad', 'dark');
    await js(`document.querySelector('.line-button').click()`);
    // Allow the existing popover entrance animation to finish.
    await new Promise(resolve => setTimeout(resolve, 300));
    await save('accounts');
    win.destroy();

    const images = {};
    for (const name of ['keypad', 'active-call', 'activity']) images[name] = `data:image/png;base64,${(await fs.readFile(path.join(output, `${name}.png`))).toString('base64')}`;
    const hero = new BrowserWindow({ width: 2472, height: 1704, frame: false, show: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    hero.webContents.setZoomFactor(2);
    const html = `<!doctype html><html><head><style>
      * { box-sizing: border-box; }
      body { margin: 0; width: 1236px; height: 852px; overflow: hidden; color: #27272a;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f7; }
      main { display: flex; gap: 24px; padding: 24px; }
      figure { margin: 0; width: 380px; }
      figcaption { height: 36px; font-size: 17px; line-height: 24px; font-weight: 600; }
      img { display: block; width: 380px; height: 740px; border-radius: 8px; outline: 1px solid #d4d4d8; }
      footer { position: absolute; bottom: 18px; left: 24px; color: #626268; font-size: 12px; }
    </style></head><body>
    <main>${[['keypad', 'Dialer'], ['active-call', 'Active Call'], ['activity', 'Activity Log']].map(([name, label]) => `<figure><figcaption>${label}</figcaption><img src="${images[name]}" alt="${label}" /></figure>`).join('')}</main>
    <footer>Screenshots use fictional accounts and call data.</footer></body></html>`;
    await hero.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    hero.webContents.setZoomFactor(2);
    await hero.webContents.executeJavaScript(`Promise.all([...document.images].map(image => image.decode()))`);
    await hero.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await fs.writeFile(path.join(output, 'overview.png'), (await hero.webContents.capturePage()).toPNG());
    console.log('Captured overview');
    hero.destroy();
  }
}
