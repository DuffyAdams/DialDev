const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/** Wraps signed 16-bit PCM in the frame format dialdev-transcribe reads: "DDA1", rate, channels, byte count, samples. */
function audioFrame(rate, channels, pcm) {
  const header = Buffer.alloc(16); header.write('DDA1', 0, 'ascii'); header.writeUInt32LE(rate, 4); header.writeUInt16LE(channels, 8); header.writeUInt32LE(pcm.length, 12);
  return Buffer.concat([header, pcm]);
}
function decodeLines(buffer, receive) {
  let newline;
  while ((newline = buffer.indexOf(10)) >= 0) { const line = buffer.subarray(0, newline).toString(); buffer = buffer.subarray(newline + 1); try { receive(JSON.parse(line)); } catch { /* Ignore partial or foreign output. */ } }
  if (buffer.length > 1_000_000) throw new Error('Oversized transcriber output.');
  return buffer;
}
/** Passes on only the fields the interface uses, with bounded sizes. */
function sanitize(m) {
  if (!m || typeof m !== 'object') return null;
  const side = m.side === 'local' || m.side === 'remote' ? m.side : null; const time = v => Number.isFinite(v) ? Math.round(v) : undefined;
  const text = v => typeof v === 'string' ? v.slice(0, 4000) : '';
  if (m.type === 'text' && side) return { type: 'text', side, final: m.final === true, text: text(m.text), start: time(m.start), end: time(m.end) };
  if (m.type === 'dtmf' && side && /^[0-9*#A-D]$/.test(m.digit)) return { type: 'dtmf', side, digit: m.digit, time: time(m.time) };
  if (m.type === 'started') return { type: 'started', engine: text(m.engine).slice(0, 60), locale: text(m.locale).slice(0, 40), language: text(m.language).slice(0, 80) };
  if (m.type === 'status' || m.type === 'error') return { type: m.type, message: text(m.message).slice(0, 300) };
  if (m.type === 'end') return { type: 'end' };
  return null;
}

/** Runs one dialdev-transcribe process per call and relays its results. Native calls write audio to the helper's FIFOs from Baresip; WebRTC calls send audio here. */
class Transcriber {
  constructor({ binary, directory, emit }) { this.binary = binary; this.directory = directory; this.emit = emit; this.sessions = new Map(); this.checks = new Map(); }
  async info(locale = '') {
    if (typeof locale !== 'string' || !/^[a-zA-Z0-9-]{0,40}$/.test(locale)) throw new Error('Invalid language.');
    try { await fsp.access(this.binary); } catch { return { available: false, reason: process.platform === 'darwin' ? 'The transcription helper is not built. Run npm run native:transcriber.' : 'Live transcription is available on macOS.', locales: [] }; }
    const cached = this.checks.get(locale); if (cached && Date.now() - cached.time < 30000) return cached.result;
    const result = await new Promise(resolve => {
      const child = spawn(this.binary, ['--check', ...(locale ? ['--locale', locale] : [])], { stdio: ['ignore', 'pipe', 'ignore'] }); let out = '';
      const timer = setTimeout(() => child.kill(), 15000);
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('error', () => { clearTimeout(timer); resolve({ available: false, reason: 'The transcription helper could not start.', locales: [] }); });
      child.on('close', () => { clearTimeout(timer); try { const r = JSON.parse(out); resolve({ available: r.available === true, reason: typeof r.reason === 'string' ? r.reason : undefined, engine: r.engine, locale: r.locale, language: r.language, installed: r.installed === true, locales: Array.isArray(r.locales) ? r.locales.filter(l => typeof l?.id === 'string' && typeof l?.name === 'string') : [] }); } catch { resolve({ available: false, reason: 'The transcription helper returned an invalid response.', locales: [] }); } });
    });
    this.checks.set(locale, { time: Date.now(), result }); return result;
  }
  /** Starts a session and resolves with the token Baresip uses to find its FIFOs once the helper is listening. */
  async start(key, { locale = '', webrtc = false } = {}) {
    if (this.sessions.has(key)) throw new Error('This call is already being transcribed.');
    if (typeof locale !== 'string' || !/^[a-zA-Z0-9-]{0,40}$/.test(locale)) throw new Error('Invalid language.');
    try { await fsp.access(this.binary); } catch { throw new Error('Live transcription is not available on this computer.'); }
    await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const token = crypto.randomUUID(); const prefix = path.join(this.directory, token);
    const child = spawn(this.binary, ['--input', prefix, ...(locale ? ['--locale', locale] : [])], { stdio: ['pipe', 'pipe', 'ignore'] });
    const session = { key, token, prefix, child, writers: null, ended: false, timers: [] }; this.sessions.set(key, session);
    let buffer = Buffer.alloc(0), ready, failed;
    const started = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      try { buffer = decodeLines(Buffer.concat([buffer, chunk]), message => { if (message?.type === 'ready') { ready(); return; } const event = sanitize(message); if (!event) return; if (event.type === 'end') session.ended = true; if (event.type === 'error') failed(new Error(event.message)); this.emit({ kind: 'transcript', call: key, transcript: event }); }); }
      catch { child.kill(); }
    });
    child.on('error', error => failed(error));
    child.on('exit', () => {
      failed(new Error('The transcription helper stopped.')); session.timers.forEach(clearTimeout); session.writers?.forEach(w => w.destroy());
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      for (const side of [0, 1]) fs.rm(`${prefix}-${side}.fifo`, { force: true }, () => {});
      if (!session.ended) this.emit({ kind: 'transcript', call: key, transcript: { type: 'end' } });
    });
    let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The transcription helper did not respond.')), 8000); });
    try { await Promise.race([started, timeout]); }
    catch (error) { child.kill(); throw error; }
    finally { clearTimeout(timer); }
    if (webrtc) session.writers = [0, 1].map(side => fs.createWriteStream(`${prefix}-${side}.fifo`).on('error', () => {}));
    return token;
  }
  /** Audio from a WebRTC call: 16-bit mono PCM for one side. Drops audio rather than queueing without bound. */
  audio(key, side, rate, pcm) {
    const writer = this.sessions.get(key)?.writers?.[side];
    if (!writer || writer.destroyed || !Number.isInteger(rate) || rate < 8000 || rate > 192000 || !(pcm instanceof Uint8Array) || pcm.length > 1_000_000 || pcm.length % 2) return;
    if (writer.writableLength < 2_000_000) writer.write(audioFrame(rate, 1, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length)));
  }
  /** Ends a session. The helper transcribes the audio it has, reports final results, then exits. */
  stop(key, grace = 0) {
    const session = this.sessions.get(key); if (!session || session.stopping) return; session.stopping = true;
    session.writers?.forEach(w => w.end());
    session.timers.push(setTimeout(() => { session.child.stdin.end('stop\n'); }, grace));
    session.timers.push(setTimeout(() => { if (session.child.exitCode === null) session.child.kill(); }, grace + 60000));
  }
  stopAll() { for (const session of this.sessions.values()) session.child.kill(); this.sessions.clear(); }
}

module.exports = { Transcriber, audioFrame, decodeLines, sanitize };
