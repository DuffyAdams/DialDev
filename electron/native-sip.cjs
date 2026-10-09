const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');

function validateAccount(a) {
  if (!a || !/^[a-zA-Z0-9-]{1,80}$/.test(a.id)) throw new Error('Invalid account.');
  if (!['udp', 'tcp', 'tls'].includes(a.transport)) throw new Error('Choose UDP, TCP, or TLS for native SIP.');
  if (typeof a.domain !== 'string' || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F\d:]+\])$/.test(a.domain)) throw new Error('Enter a SIP hostname or IP address, without a protocol.');
  if (!/^\d{1,5}$/.test(a.port) || +a.port < 1 || +a.port > 65535) throw new Error('SIP port must be between 1 and 65535.');
  if (typeof a.username !== 'string' || !a.username || a.username.length > 256 || /[\r\n]/.test(a.username)) throw new Error('Invalid SIP username.');
  if (a.proxy && !/^sips?:[a-zA-Z0-9_.:@;=+\[\]-]+$/.test(a.proxy)) throw new Error('Enter a valid outbound SIP proxy URI.');
  if (a.stun && !/^stuns?:[a-zA-Z0-9_.:\[\]-]+$/.test(a.stun)) throw new Error('Enter a valid STUN server URI.');
  return a;
}
function addressFor(a) {
  validateAccount(a);
  return `<sip:${encodeURIComponent(a.username)}@${a.domain}:${a.port};transport=${a.transport}>;regint=${a.outboundOnly ? 0 : 300};answermode=manual;sip_autoanswer=no;dtmfmode=rtpevent;audio_codecs=opus/48000/2,pcmu/8000/1,pcma/8000/1${a.mediaEncryption === 'srtp' ? ';mediaenc=srtp-mand' : ''}${a.proxy ? `;outbound="${a.proxy}"` : ''}${a.stun ? `;medianat=stun;stunserver="${a.stun}"` : ''}`;
}
function decodeFrames(buffer, receive) {
  while (buffer.length) {
    const colon = buffer.indexOf(58); if (colon < 0) { if (buffer.length > 9) throw new Error('Invalid native frame.'); break; }
    const header = buffer.subarray(0, colon).toString(); if (!/^\d{1,8}$/.test(header)) throw new Error('Invalid native frame.');
    const len = Number(header); if (len > 2_000_000) throw new Error('Oversized native frame.'); if (buffer.length < colon + len + 2) break;
    if (buffer[colon + len + 1] !== 44) throw new Error('Invalid native frame terminator.');
    receive(JSON.parse(buffer.subarray(colon + 1, colon + len + 1).toString())); buffer = buffer.subarray(colon + len + 2);
  }
  return buffer;
}
function mixWav(local, remote) {
  const read = b => { if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.readUInt16LE(20) !== 1 || b.readUInt16LE(34) !== 16) throw new Error('Invalid recording format.'); const rate = b.readUInt32LE(24), channels = b.readUInt16LE(22); return { b, rate, channels, frames: Math.floor((b.length - 44) / (channels * 2)) }; };
  const a = read(local), b = read(remote), rate = Math.max(a.rate, b.rate), frames = Math.ceil(Math.max(a.frames / a.rate, b.frames / b.rate) * rate);
  const out = Buffer.alloc(44 + frames * 4); out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(frames * 4, 40);
  const sample = (s, i) => { const frame = Math.floor(i * s.rate / rate); if (frame >= s.frames) return 0; let sum = 0; for (let ch = 0; ch < s.channels; ch++) sum += s.b.readInt16LE(44 + (frame * s.channels + ch) * 2); return Math.round(sum / s.channels); };
  for (let i = 0; i < frames; i++) { out.writeInt16LE(sample(a, i), 44 + i * 4); out.writeInt16LE(sample(b, i), 46 + i * 4); }
  return out;
}
class NativeSip {
  constructor({ binary, directory, emit, test = false }) { this.binary = binary; this.directory = directory; this.emit = emit; this.test = test; this.accounts = new Map(); this.pending = new Map(); this.recordingIds = new Set(); this.auth = crypto.randomBytes(32).toString('hex'); this.starting = null; this.queue = Promise.resolve(); }
  async start() { if (this.socket && !this.socket.destroyed) return; if (this.starting) return this.starting; this.starting = this.boot().finally(() => { this.starting = null; }); return this.starting; }
  async boot() {
    try { await fs.access(this.binary); } catch { throw new Error(`Native SIP is not built for ${process.platform}/${process.arch}. Use a WebRTC account, or build the native engine for this platform.`); }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 }); this.recordDir = path.join(this.directory, 'recordings'); await fs.mkdir(this.recordDir, { recursive: true, mode: 0o700 });
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
    const caFile = path.join(this.directory, 'trusted-ca.pem'); await fs.writeFile(caFile, tls.rootCertificates.join('\n'));
    const audio = this.test ? 'aufile' : process.platform === 'darwin' ? 'audiounit' : process.platform === 'win32' ? 'winwave' : 'pulse';
    const config = [...(this.test ? ['net_interface 127.0.0.1', 'sip_listen 127.0.0.1:0'] : []), `sip_transports udp,tcp,tls`, `sip_verify_server yes`, `sip_cafile ${caFile}`, 'call_max_calls 5', 'call_hold_other_calls no', 'call_local_timeout 60', 'call_accept no', `audio_source ${this.test ? 'ausine,440' : audio + ',default'}`, `audio_player ${this.test ? 'aubridge,test' : audio + ',default'}`, `audio_alert ${audio},default`, 'ausrc_format s16', 'auplay_format s16', 'auenc_format s16', 'audec_format s16', 'audio_jitter_buffer_type adaptive', 'audio_jitter_buffer_ms 40-160', 'audio_buffer 20-160', 'rtp_stats no', 'ring_aufile none', 'ringback_aufile none', 'callwaiting_aufile none', 'message_sound no', 'sip_trace no', 'netroam_interval 5', `ctrl_tcp_listen 127.0.0.1:${port}`, ...[audio, ...(this.test ? ['ausine', 'aubridge'] : []), 'aufile', 'g711', 'opus', 'uuid', 'stun', 'turn', 'ice', 'srtp', 'dtls_srtp', 'mixminus'].filter((x, i, list) => list.indexOf(x) === i).map(m => `module ${m}.so`), 'module_app menu.so', 'module_app dialdev.so', 'module_app mwi.so', 'module_app netroam.so', 'module_app ctrl_tcp.so'].join('\n') + '\n';
    await fs.writeFile(path.join(this.directory, 'config'), config, { mode: 0o600 });
    this.child = spawn(this.binary, ['-f', this.directory], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DIALDEV_CTRL_TOKEN: this.auth, DIALDEV_REC_DIR: this.recordDir } });
    // Drain logs without storing caller information, credentials, or SIP traces.
    this.child.stdout.on('data', chunk => { if (this.test && process.env.DIALDEV_TEST_VERBOSE) process.stdout.write(chunk); }); this.child.stderr.on('data', chunk => { if (this.test && process.env.DIALDEV_TEST_VERBOSE) process.stderr.write(chunk); });
    let startupError; this.child.once('error', e => { startupError = e; });
    this.child.once('exit', () => { this.socket?.destroy(); this.socket = null; for (const [, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error('The native SIP engine stopped.')); } this.pending.clear(); for (const id of this.accounts.keys()) this.emit({ kind: 'connection', accountId: id, state: 'error', detail: 'The native engine stopped. Reconnect this account.' }); this.accounts.clear(); });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (startupError) throw startupError;
      if (this.child.exitCode !== null) throw new Error('Native SIP could not start. Check the bundled engine and audio modules.');
      try { this.socket = await new Promise((resolve, reject) => { const socket = net.connect(port, '127.0.0.1'); socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); }); socket.once('error', e => { socket.destroy(); reject(e); }); }); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    if (!this.socket) { this.child.kill(); throw new Error('The native SIP engine did not respond.'); }
    let buffer = Buffer.alloc(0); this.socket.on('data', chunk => { try { buffer = decodeFrames(Buffer.concat([buffer, chunk]), frame => this.receive(frame)); } catch { this.socket.destroy(); this.child.kill(); } });
    this.socket.on('error', () => { this.child?.kill(); });
    await this.request('about', '');
  }
  request(command, params) { return new Promise((resolve, reject) => { if (!this.socket || this.socket.destroyed) { reject(new Error('Native SIP is offline.')); return; } const token = crypto.randomUUID(); const body = Buffer.from(JSON.stringify({ command, params, token, auth: this.auth })); if (body.length > 16000) { reject(new Error('The request is too large.')); return; } const timer = setTimeout(() => { this.pending.delete(token); reject(new Error('Native SIP request timed out.')); }, 12000); this.pending.set(token, { resolve, reject, timer }); this.socket.write(Buffer.concat([Buffer.from(`${body.length}:`), body, Buffer.from(',')])); }); }
  async command(payload) { return this.request('dialdev', JSON.stringify(payload)); }
  receive(frame) {
    if (frame.response && frame.token) { const p = this.pending.get(frame.token); if (p) { clearTimeout(p.timer); this.pending.delete(frame.token); frame.ok ? p.resolve(frame.data) : p.reject(new Error(`SIP operation failed: ${String(frame.data || 'Unknown error').slice(0, 200)}`)); } return; }
    if (frame.type === 'MODULE' && frame.param?.startsWith('dialdev,')) {
      const [, event, ...rest] = frame.param.split(','); const param = rest.join(',');
      if (event === 'recording' || event === 'recording-error') { if (this.recordingIds.has(param)) { this.emit({ kind: event, token: param }); } return; }
      if (event === 'message') { const [token, status] = param.split(' '); this.emit({ kind: 'message-status', token, status: Number(status) }); return; }
    }
    let accountId; const aor = frame.accountaor || frame.ua;
    for (const [id, account] of this.accounts) if (account.aor === aor || (aor && account.expected === aor.split(';')[0])) { accountId = id; break; }
    if (!accountId && aor) for (const [id, a] of this.accounts) if (aor.startsWith(`sip:${encodeURIComponent(a.username)}@${a.domain}`)) { accountId = id; break; }
    if (!accountId) return;
    if (frame.type === 'REGISTER_OK') this.emit({ kind: 'connection', accountId, state: 'registered' });
    else if (frame.type === 'REGISTER_FAIL') this.emit({ kind: 'connection', accountId, state: 'error', detail: String(frame.param || 'Registration failed. Check your provider settings.').slice(0, 200) });
    else if (frame.type === 'REGISTERING') this.emit({ kind: 'connection', accountId, state: 'connecting' });
    else if (frame.message) this.emit({ kind: 'message', accountId, peer: frame.from, body: frame.body });
    else this.emit({ kind: 'event', accountId, ...frame });
  }
  /** Has the engine look for changed network addresses now (a VPN going up or down) instead of at its next poll, so retrying doesn't reuse sockets bound to an address that no longer exists. */
  async refreshNetwork() { await this.request('netchange', '').catch(() => {}); }
  async connect(a, secret) {
    validateAccount(a); await this.start(); if (this.accounts.has(a.id)) await this.disconnect(a.id); await this.refreshNetwork();
    const expected = `sip:${encodeURIComponent(a.username)}@${a.domain}:${a.port}`; this.accounts.set(a.id, { ...a, expected }); this.emit({ kind: 'connection', accountId: a.id, state: 'connecting' });
    try { const aor = await this.command({ action: 'connect', address: addressFor(a), password: secret.password, authUser: a.authUser || a.username, displayName: a.displayName || undefined }); const account = this.accounts.get(a.id); if (account) account.aor = aor; } catch (e) { this.accounts.delete(a.id); throw e; }
    // An outbound-only account sends no REGISTER, so no registration event will say it is ready.
    if (a.outboundOnly) this.emit({ kind: 'connection', accountId: a.id, state: 'registered', detail: 'Outbound only' });
  }
  async disconnect(id) { const a = this.accounts.get(id); if (!a) return; await this.command({ action: 'disconnect', aor: a.aor }); this.accounts.delete(id); this.emit({ kind: 'connection', accountId: id, state: 'offline' }); }
  async action(payload) {
    const actions = ['dial', 'answer', 'end', 'forward', 'hold', 'resume', 'mute', 'unmute', 'dtmf', 'transfer', 'attended', 'record', 'record-stop', 'transcribe', 'transcribe-stop', 'merge', 'split', 'message'];
    if (!payload || !actions.includes(payload.action)) throw new Error('Unsupported call action.');
    const result = { action: payload.action };
    if (payload.accountId) { const a = this.accounts.get(payload.accountId); if (!a) throw new Error('Connect this account first.'); result.aor = a.aor; }
    for (const key of ['call', 'other', 'to', 'body', 'token']) if (payload[key] !== undefined) { if (typeof payload[key] !== 'string' || payload[key].length > (key === 'body' ? 4000 : 600) || (key !== 'body' && /[\r\n]/.test(payload[key]))) throw new Error('Invalid call parameter.'); result[key] = payload[key]; }
    if (payload.action === 'record') { if (!/^[a-zA-Z0-9-]{1,70}$/.test(result.token || '')) throw new Error('Invalid recording ID.'); this.recordingIds.add(result.token); }
    if (payload.action === 'transcribe' && !/^[a-zA-Z0-9-]{1,70}$/.test(result.token || '')) throw new Error('Invalid transcription ID.');
    return this.command(result);
  }
  async readRecording(token) { if (!this.recordingIds.has(token) || !/^[a-zA-Z0-9-]{1,70}$/.test(token)) throw new Error('Unknown recording.'); const files = [0, 1].map(side => path.join(this.recordDir, `${token}-${side}.wav`)); const buffers = await Promise.all(files.map(file => fs.readFile(file))); const mixed = mixWav(...buffers); await Promise.all(files.map(file => fs.rm(file, { force: true }))); this.recordingIds.delete(token); return mixed; }
  stop() { this.socket?.destroy(); const child = this.child; child?.kill('SIGTERM'); const timer = setTimeout(() => { if (child && child.exitCode === null) child.kill('SIGKILL'); }, 1500); timer.unref(); }
}
module.exports = { NativeSip, validateAccount, addressFor, decodeFrames, mixWav };
