const { app, BrowserWindow, ipcMain, safeStorage, protocol, net, session, Menu, Notification, powerSaveBlocker, dialog, nativeTheme, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { NativeSip } = require('./native-sip.cjs');
const { Transcriber } = require('./transcriber.cjs');
const { selectProfile } = require('./profile.cjs');
const { Updater } = require('./updater.cjs');

app.setName('DialDev');
const profile = selectProfile({ userData: path.join(app.getPath('appData'), 'DialDev'), testData: process.env.DIALDEV_TEST_DATA });
app.setPath('userData', profile.directory);
protocol.registerSchemesAsPrivileged([{ scheme: profile.scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const appIcon = path.join(__dirname, '..', 'build', 'icon.png');
let win, active = false, blocker, pendingDial, nativeSip, transcriber, updater, quitting = false;
/** Updates are read from this repository's latest GitHub release, which must be publicly readable. */
const UPDATE_REPOSITORY = 'DuffyAdams/DevDial';
const devURL = !app.isPackaged && process.env.DIALDEV_DEV_URL === 'http://127.0.0.1:5173' ? process.env.DIALDEV_DEV_URL : null;
const trusted = url => { try { const u = new URL(url); return devURL ? u.origin === devURL : u.protocol === `${profile.scheme}:` && u.host === 'app'; } catch { return false; } };
function guard(event) { if (!event.senderFrame || event.senderFrame !== win?.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('Untrusted IPC sender.'); }
function secretPath(id) { if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid account ID.'); return path.join(app.getPath('userData'), profile.vault, `${id}.bin`); }
function cryptoAvailable() { return safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'); }
/** Renderer call IDs: a UUID for WebRTC calls, or "native:" and the SIP Call-ID for native calls. */
function callKey(key) { if (typeof key !== 'string' || key.length > 300 || !/^[\x21-\x7e]+$/.test(key)) throw new Error('Invalid call.'); return key; }
function sendDial(uri) { if (typeof uri !== 'string' || !/^(tel|sips?):[^\r\n]{1,512}$/i.test(uri)) return; if (win) { win.show(); win.focus(); if (win.webContents.isLoading()) pendingDial = uri; else win.webContents.send('dial', uri); } else pendingDial = uri; }

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_, argv) => { win?.show(); win?.focus(); const uri = argv.find(a => /^(tel|sips?):/i.test(a)); if (uri) sendDial(uri); });
  app.on('open-url', (event, uri) => { event.preventDefault(); sendDial(uri); });
  app.whenReady().then(async () => {
    app.setAboutPanelOptions({ applicationName: 'DialDev', applicationVersion: app.getVersion(), iconPath: appIcon });
    if (process.platform === 'darwin') app.dock.setIcon(appIcon);
    const nativeRoot = app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(__dirname, '..', 'native');
    const runtime = path.join(app.getPath('userData'), 'sip-runtime'), sendEvent = event => win?.webContents.send('sip:event', event);
    nativeSip = new NativeSip({ binary: path.join(nativeRoot, `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'baresip.exe' : 'baresip'), directory: runtime, emit: sendEvent });
    // The engine opens transcription FIFOs from its private audio directory (DIALDEV_REC_DIR), so the helper creates them there.
    transcriber = new Transcriber({ binary: path.join(nativeRoot, `${process.platform}-${process.arch}`, 'dialdev-transcribe'), directory: path.join(runtime, 'recordings'), emit: sendEvent });
    // The running bundle is …/DialDev.app/Contents/MacOS/DialDev.
    updater = new Updater({ repository: UPDATE_REPOSITORY, current: app.getVersion(), packaged: app.isPackaged, bundle: path.resolve(process.execPath, '..', '..', '..'), temp: app.getPath('temp'), emit: state => win?.webContents.send('update:state', state), quit: () => app.quit(), fetch: (url, init) => net.fetch(url, init) });
    protocol.handle(profile.scheme, request => {
      const u = new URL(request.url);
      if (u.host !== 'app') return new Response('Not found', { status: 404 });
      const base = path.join(__dirname, '..', 'dist');
      const file = path.resolve(base, `.${decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname)}`);
      if (!file.startsWith(base + path.sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === win?.webContents && trusted(details.requestingUrl || contents.getURL()) && ['media', 'notifications', 'speaker-selection', 'clipboard-sanitized-write'].includes(permission));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => contents === win?.webContents && trusted(origin) && ['media', 'notifications', 'speaker-selection', 'clipboard-sanitized-write'].includes(permission));
    ipcMain.handle('secret:get', async (event, id) => { guard(event); const file = secretPath(id); try { if (!cryptoAvailable()) return null; return JSON.parse(safeStorage.decryptString(await fs.readFile(file))); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Could not unlock this account. Please re-enter its password.'); } });
    ipcMain.handle('secret:save', async (event, id, secret) => {
      guard(event); const file = secretPath(id);
      if (!secret || typeof secret.password !== 'string' || typeof secret.turnPassword !== 'string' || secret.password.length > 4096 || secret.turnPassword.length > 4096) throw new Error('Invalid credentials.');
      if (!cryptoAvailable()) throw new Error('The OS credential store is unavailable. Turn off Remember password to connect for this session.');
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file + '.tmp', safeStorage.encryptString(JSON.stringify(secret)), { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
    });
    ipcMain.handle('secret:delete', async (event, id) => { guard(event); await fs.rm(secretPath(id), { force: true }); });
    ipcMain.handle('sip:connect', async (event, account, secret) => { guard(event); if (!secret || typeof secret.password !== 'string' || secret.password.length > 4096) throw new Error('Invalid credentials.'); return nativeSip.connect(account, secret); });
    ipcMain.handle('sip:disconnect', async (event, id) => { guard(event); return nativeSip.disconnect(id); });
    ipcMain.handle('sip:action', async (event, payload) => { guard(event); return nativeSip.action(payload); });
    ipcMain.handle('sip:recording', async (event, token) => { guard(event); return nativeSip.readRecording(token); });
    ipcMain.handle('transcribe:info', async (event, locale) => { guard(event); return transcriber.info(locale); });
    ipcMain.handle('transcribe:start', async (event, key, locale) => {
      guard(event); callKey(key); const native = key.startsWith('native:');
      const token = await transcriber.start(key, { locale, webrtc: !native });
      if (native) try { await nativeSip.action({ action: 'transcribe', call: key.slice(7), token }); } catch (e) { transcriber.stop(key); throw e; }
    });
    ipcMain.on('transcribe:audio', (event, key, side, rate, pcm) => { guard(event); if (typeof key === 'string' && (side === 0 || side === 1)) transcriber.audio(key, side, rate, pcm); });
    ipcMain.handle('transcribe:stop', async (event, key) => {
      guard(event); callKey(key); const native = key.startsWith('native:');
      if (native) await nativeSip.action({ action: 'transcribe-stop', call: key.slice(7) }).catch(() => { /* The call may already have closed, which also ends its audio. */ });
      // Give native audio a moment to drain from the FIFOs before asking the helper to finish.
      transcriber.stop(key, native ? 1500 : 0);
    });
    ipcMain.handle('update:state', event => { guard(event); return updater.state; });
    ipcMain.handle('update:check', async event => { guard(event); return updater.check(); });
    ipcMain.handle('update:install', async event => { guard(event); if (active) throw new Error('End your calls before updating.'); await updater.install(); });
    ipcMain.on('update:open', event => { guard(event); const url = updater.state.url; if (typeof url === 'string' && url.startsWith('https://github.com/')) void shell.openExternal(url); });
    ipcMain.on('notify', (event, title, body) => { guard(event); if (typeof title !== 'string' || typeof body !== 'string') return; const notice = new Notification({ title: title.slice(0, 100), body: body.slice(0, 250), silent: true }); notice.on('click', () => { win?.show(); win?.focus(); }); notice.show(); });
    ipcMain.on('call:active', (event, value) => { guard(event); active = value === true; if (active && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension'); if (!active && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; } });
    ipcMain.on('theme:set', (event, theme) => { guard(event); if (['light', 'dark', 'system'].includes(theme)) nativeTheme.themeSource = theme; });
    ipcMain.on('window:control', (event, action) => { guard(event); if (action === 'minimize') win.minimize(); else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize(); else if (action === 'close') win.close(); });
    const background = () => nativeTheme.shouldUseDarkColors ? '#1e1e1f' : '#f7f7f8';
    nativeTheme.on('updated', () => win?.setBackgroundColor(background()));
    function createWindow() {
      win = new BrowserWindow({ width: 380, height: 740, minWidth: 360, minHeight: 600, title: 'DialDev', icon: appIcon, backgroundColor: background(), titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden', trafficLightPosition: { x: 16, y: 18 }, webPreferences: { additionalArguments: [`--dialdev-storage=${profile.scheme}`], preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
      win.webContents.on('will-prevent-unload', event => { if (quitting) event.preventDefault(); });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
      win.webContents.on('did-finish-load', () => { if (pendingDial) { win.webContents.send('dial', pendingDial); pendingDial = null; } });
      win.on('close', event => { if (!quitting && (active || process.platform === 'darwin')) { event.preventDefault(); win.hide(); } });
      win.on('closed', () => { win = null; });
      if (devURL) win.loadURL(devURL); else win.loadURL(`${profile.scheme}://app/`);
    }
    const navigate = page => { win?.show(); win?.webContents.send('navigate', page); };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: 'DialDev', submenu: [{ role: 'about' }, { label: 'Check for Updates…', click: () => { navigate('settings'); void updater.check(); } }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => navigate('settings') }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] }] : []),
      { label: 'File', submenu: [{ label: 'New Call', accelerator: 'CmdOrCtrl+N', click: () => navigate('dial') }, { label: 'Accounts…', accelerator: 'CmdOrCtrl+L', click: () => navigate('accounts') }, { label: 'New Account…', accelerator: 'CmdOrCtrl+Shift+N', click: () => navigate('new-account') }, ...(process.platform !== 'darwin' ? [{ type: 'separator' }, { label: 'Settings', accelerator: 'Ctrl+,', click: () => navigate('settings') }, { role: 'quit' }] : [])] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ label: 'Recents', accelerator: 'CmdOrCtrl+1', click: () => navigate('history') }, { label: 'Contacts', accelerator: 'CmdOrCtrl+2', click: () => navigate('contacts') }, { label: 'Keypad', accelerator: 'CmdOrCtrl+3', click: () => navigate('keypad') }, { label: 'Messages', accelerator: 'CmdOrCtrl+4', click: () => navigate('messages') }, { label: 'Activity', accelerator: 'CmdOrCtrl+5', click: () => navigate('activity') }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] }, { role: 'windowMenu' }
    ]));
    createWindow();
    app.on('activate', () => win ? win.show() : createWindow());
  });
  app.on('before-quit', event => { if (active) { const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep calling', 'End calls and quit'], defaultId: 0, cancelId: 0, message: 'End active calls and quit?', detail: 'Quitting DialDev disconnects all calls in progress.' }); if (choice === 0) event.preventDefault(); else active = false; } if (!event.defaultPrevented) quitting = true; });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => { transcriber?.stopAll(); nativeSip?.stop(); });
}
