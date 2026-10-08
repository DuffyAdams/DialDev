/* On-device transcription and in-band DTMF detection, fed the way a WebRTC call feeds it. macOS 26+ only; uses synthetic speech from `say`. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { Transcriber } = require('../electron/transcriber.cjs');
const wait = async (condition, name, timeout = 20000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = condition(); if (value) return value; await new Promise(r => setTimeout(r, 50)); } throw new Error(`Timed out: ${name}`); };
const binary = process.env.DIALDEV_TRANSCRIBER || path.resolve('native/darwin-arm64/dialdev-transcribe');
const RATE = 8000;
/** Speech from the macOS voice, as 8 kHz mono samples (telephone bandwidth). */
async function speech(directory, text) {
  const file = path.join(directory, `${Math.random().toString(36).slice(2)}.wav`);
  execFileSync('say', ['-o', file, `--data-format=LEI16@${RATE}`, text], { timeout: 30000 });
  const wav = await fs.readFile(file); let offset = 12;
  while (offset < wav.length && wav.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + wav.readUInt32LE(offset + 4);
  return new Int16Array(wav.buffer.slice(wav.byteOffset + offset + 8, wav.byteOffset + offset + 8 + wav.readUInt32LE(offset + 4)));
}
const onset = samples => samples.findIndex(v => Math.abs(v) > 500) / RATE;
const silence = seconds => new Int16Array(Math.round(seconds * RATE));
const pairs = { 1: [697, 1209], 5: [770, 1336], '#': [941, 1477] };
const tone = (digit, seconds) => Int16Array.from({ length: Math.round(seconds * RATE) }, (_, i) => Math.round(6000 * pairs[digit].reduce((sum, f) => sum + Math.sin(2 * Math.PI * f * i / RATE), 0)));
const join = parts => { const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };

(async () => {
  const transcriber = new Transcriber({ binary, directory: await fs.mkdtemp('/private/tmp/dialdev-transcribe-test-'), emit: e => events.push(e) });
  const events = [];
  const info = await transcriber.info('en-US');
  if (!info.available) { console.log(`SKIP ${info.reason}`); return; }
  assert.ok(info.locales.some(l => l.id === 'en-US')); console.log(`PASS Availability check (${info.engine}, ${info.locales.length} languages)`);
  const scratch = transcriber.directory;
  const prompt = await speech(scratch, 'Thank you for calling Acme support. For billing, press 1. For technical support, press 2.');
  const tones = join([tone('1', 0.12), silence(0.08), tone('5', 0.1), silence(0.08), tone('#', 0.15)]);
  const followUp = await speech(scratch, 'Please hold while we transfer your call.');
  const toneAt = (prompt.length / RATE + 0.6), followUpAt = toneAt + tones.length / RATE + 2.5;
  const remote = join([prompt, silence(0.6), tones, silence(2.5), followUp, silence(1)]);
  const request = await speech(scratch, 'I would like to check my balance.');
  const local = join([silence(4), request, silence(Math.max(0, remote.length / RATE - 6.5))]).slice(0, remote.length);
  // A 1.5 second hole in the remote audio before the second prompt, as hold or silence suppression would leave.
  const hole = [Math.round((followUpAt - 2) * RATE), Math.round((followUpAt - 0.5) * RATE)];
  await transcriber.start('call-1', { locale: 'en-US', webrtc: true });
  const began = Date.now(); const frame = RATE / 50;
  for (let i = 0; i < remote.length; i += frame) {
    if (i < hole[0] || i >= hole[1]) transcriber.audio('call-1', 1, RATE, new Uint8Array(remote.slice(i, i + frame).buffer));
    transcriber.audio('call-1', 0, RATE, new Uint8Array(local.slice(i, i + frame).buffer));
    const due = began + (i + frame) / RATE * 1000; await new Promise(r => setTimeout(r, Math.max(0, due - Date.now())));
  }
  transcriber.stop('call-1');
  await wait(() => events.some(e => e.transcript.type === 'end'), 'session end', 30000);
  const of = type => events.map(e => e.transcript).filter(t => t.type === type);
  const finals = side => of('text').filter(t => t.final && t.side === side);
  const remoteText = finals('remote').map(t => t.text).join(' '), localText = finals('local').map(t => t.text).join(' ');
  const at = t => `${((t - began) / 1000).toFixed(2)}s`;
  console.log(`  remote: ${finals('remote').map(t => `[${at(t.start)}] ${t.text}`).join(' ')}\n  local:  ${finals('local').map(t => `[${at(t.start)}] ${t.text}`).join(' ')}\n  dtmf:   ${of('dtmf').map(t => `${t.digit}@${at(t.time)}`).join(' ')} (expected first at ${toneAt.toFixed(2)}s)\n  speech expected at local ${(4 + onset(request)).toFixed(2)}s, remote follow-up ${(followUpAt + onset(followUp)).toFixed(2)}s`);
  assert.equal(of('started').length, 1, 'reports the engine and language');
  assert.match(remoteText, /billing/i); assert.match(remoteText, /press (1|one)/i); assert.match(remoteText, /transfer/i); assert.match(localText, /balance/i);
  assert.ok(of('text').some(t => !t.final && t.text), 'streams volatile results');
  console.log('PASS Both sides transcribed on device, with live partial results');
  assert.deepEqual(of('dtmf').map(t => `${t.side}:${t.digit}`), ['remote:1', 'remote:5', 'remote:#']);
  assert.ok(Math.abs(of('dtmf')[0].time - (began + toneAt * 1000)) < 300, 'tone timestamp matches when it was sent');
  console.log('PASS In-band DTMF detected in order, with no false digits from speech');
  const transfer = finals('remote').find(t => /transfer/i.test(t.text)), billing = finals('remote').find(t => /billing/i.test(t.text));
  assert.ok(billing.start < of('dtmf')[0].time && of('dtmf')[0].time < transfer.start, 'speech and tones share one timeline');
  assert.ok(Math.abs(transfer.start - (began + (followUpAt + onset(followUp)) * 1000)) < 250, 'speech after a gap in the audio keeps wall-clock time');
  assert.ok(Math.abs(finals('local')[0].start - (began + (4 + onset(request)) * 1000)) < 250, 'phrase starts where speech starts');
  console.log('PASS Speech and tones on one wall-clock timeline, across a gap in the audio');
  await fs.rm(scratch, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exitCode = 1; });
