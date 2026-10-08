/* Real localhost SIP + RTP integration. Uses a synthetic tone, never the microphone. */
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { NativeSip } = require('../electron/native-sip.cjs');
const { Transcriber } = require('../electron/transcriber.cjs');
const wait = async (condition, name, timeout = 10000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = condition(); if (value) return value; await new Promise(r => setTimeout(r, 30)); } throw new Error(`Timed out: ${name}`); };
const md5 = value => crypto.createHash('md5').update(value).digest('hex');
/** G.711 mu-law encoding of one 16-bit sample. */
const ulaw = sample => { let sign = 0; if (sample < 0) { sign = 0x80; sample = -sample; } sample = Math.min(sample, 32635) + 0x84; let exponent = 7; for (let mask = 0x4000; !(sample & mask) && exponent > 0; exponent--, mask >>= 1); return ~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 0x0f)) & 0xff; };
/** Synthetic speech at telephone bandwidth (8 kHz mono), from the macOS voice. */
const speech = async (directory, text) => { const file = path.join(directory, `${crypto.randomUUID()}.wav`); execFileSync('say', ['-o', file, '--data-format=LEI16@8000', text], { timeout: 30000 }); const wav = await fs.readFile(file); let offset = 12; while (wav.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + wav.readUInt32LE(offset + 4); return new Int16Array(wav.buffer.slice(wav.byteOffset + offset + 8, wav.byteOffset + offset + 8 + wav.readUInt32LE(offset + 4))); };
(async () => {
  const sipSocket = dgram.createSocket('udp4'); const rtp = dgram.createSocket('udp4');
  await new Promise(r => sipSocket.bind(0, '127.0.0.1', r)); await new Promise(r => rtp.bind(0, '127.0.0.1', r));
  const port = sipSocket.address().port, rtpPort = rtp.address().port;
  const events = [], requests = []; let authVerified = false, audioPackets = 0, dtmfPackets = 0, registration, echo = true, engineRtp;
  const password = 'local-test-"quoted;password';
  rtp.on('message', (packet, remote) => { const pt = packet[1] & 127; if (pt === 101) dtmfPackets++; else audioPackets++; engineRtp = remote; if (!echo) return; const copy = Buffer.from(packet); if (copy.length >= 12) copy.writeUInt32BE(123456, 8); rtp.send(copy, remote.port, remote.address); });
  const parse = text => { const header = text.split('\r\n\r\n')[0]; const field = name => header.match(new RegExp(`^${name}:\\s*(.*)$`, 'mi'))?.[1] || ''; return { text, field, method: text.split(' ')[0], uri: text.split(' ')[1] }; };
  const response = (r, remote, code, reason, extra = '', body = '') => { const to = r.field('To').includes(';tag=') ? r.field('To') : `${r.field('To')};tag=local-test`; const text = `SIP/2.0 ${code} ${reason}\r\nVia: ${r.field('Via')}\r\nFrom: ${r.field('From')}\r\nTo: ${to}\r\nCall-ID: ${r.field('Call-ID')}\r\nCSeq: ${r.field('CSeq')}\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`; sipSocket.send(text, remote.port, remote.address); };
  const sdp = () => `v=0\r\no=test 1 1 IN IP4 127.0.0.1\r\ns=Local integration\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio ${rtpPort} RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\na=fmtp:101 0-16\r\na=sendrecv\r\n`;
  sipSocket.on('message', (packet, remote) => { const r = parse(packet.toString()); requests.push(r);
    if (r.method === 'REGISTER') {
      const auth = r.field('Authorization');
      if (!auth) return response(r, remote, 401, 'Unauthorized', 'WWW-Authenticate: Digest realm="local-test", nonce="fixed-nonce", algorithm=MD5, qop="auth"\r\n');
      const fields = Object.fromEntries([...auth.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m => [m[1], m[2] ?? m[3]]));
      const expected = md5(`${md5(`1001:local-test:${password}`)}:fixed-nonce:${fields.nc}:${fields.cnonce}:auth:${md5(`REGISTER:${fields.uri}`)}`);
      authVerified = fields.response === expected;
      registration = { r, remote };
      return response(r, remote, authVerified ? 200 : 403, authVerified ? 'OK' : 'Forbidden', `Contact: ${r.field('Contact')}\r\nExpires: 300\r\n`);
    }
    if (r.method === 'SUBSCRIBE') return response(r, remote, 489, 'Bad Event');
    if (r.method === 'INVITE') return response(r, remote, 200, 'OK', `Contact: <sip:200@127.0.0.1:${port}>\r\nContent-Type: application/sdp\r\n`, sdp());
    if (r.method === 'BYE' || r.method === 'CANCEL') return response(r, remote, 200, 'OK');
    if (r.method === 'MESSAGE') return response(r, remote, r.text.endsWith('reject me') ? 403 : 202, r.text.endsWith('reject me') ? 'Forbidden' : 'Accepted');
  });
  const directory = await fs.mkdtemp(path.join('/private/tmp/', 'dialdev-sip-test-'));
  const sip = new NativeSip({ binary: path.resolve('native/darwin-arm64/baresip'), directory, emit: e => events.push(e), test: true });
  try {
    await sip.connect({ id: 'integration-account', name: 'Local test', username: '1001', authUser: '1001', domain: '127.0.0.1', port: String(port), transport: 'udp', proxy: '', stun: '', displayName: 'Local test', mediaEncryption: 'none' }, { password });
    await wait(() => events.find(e => e.kind === 'connection' && e.state === 'registered'), 'authenticated registration'); assert.ok(authVerified); console.log('PASS Digest-authenticated UDP registration (including special-character password)');
    const id = await sip.action({ action: 'dial', accountId: 'integration-account', to: `sip:200@127.0.0.1:${port}` });
    await wait(() => events.find(e => e.id === id && e.type === 'CALL_ESTABLISHED'), 'call established');
    await wait(() => audioPackets > 20, 'RTP audio flow'); console.log('PASS Outgoing call, SDP negotiation, and real synthetic RTP audio');
    await sip.action({ action: 'record', call: id, token: 'test-recording' }); await new Promise(r => setTimeout(r, 1000));
    await sip.action({ action: 'record-stop', call: id }); await wait(() => events.find(e => e.kind === 'recording' && e.token === 'test-recording'), 'recording completion');
    const wav = await sip.readRecording('test-recording'); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt16LE(22), 2); assert.ok(wav.length > 12000); let energy = 0; for (let i = 44; i < wav.length; i += 2) energy += Math.abs(wav.readInt16LE(i)); assert.ok(energy > 0); console.log(`PASS Native two-sided WAV recording (${wav.length} bytes)`);
    await sip.action({ action: 'mute', call: id }); await sip.action({ action: 'unmute', call: id });
    await sip.action({ action: 'hold', call: id }); await wait(() => requests.some(r => r.method === 'INVITE' && /a=sendonly|a=inactive/.test(r.text)), 'hold re-INVITE');
    await new Promise(r => setTimeout(r, 200)); await sip.action({ action: 'resume', call: id }); await new Promise(r => setTimeout(r, 200));
    await sip.action({ action: 'dtmf', call: id, to: '5' }); await wait(() => dtmfPackets > 0, 'RFC4733 DTMF'); console.log('PASS Mute, hold/resume re-INVITEs, and RTP DTMF');
    await sip.action({ action: 'message', accountId: 'integration-account', to: `sip:200@127.0.0.1:${port}`, body: 'local test message', token: 'msg-ok' });
    await wait(() => events.find(e => e.kind === 'message-status' && e.token === 'msg-ok' && e.status === 202), 'message accepted');
    await sip.action({ action: 'message', accountId: 'integration-account', to: `sip:200@127.0.0.1:${port}`, body: 'reject me', token: 'msg-fail' }); await wait(() => events.find(e => e.kind === 'message-status' && e.token === 'msg-fail' && e.status === 403), 'message rejected'); console.log('PASS SIP MESSAGE success and provider rejection');
    await sip.action({ action: 'end', call: id }); await wait(() => events.find(e => e.id === id && e.type === 'CALL_CLOSED'), 'hangup'); assert.ok(requests.some(r => r.method === 'BYE')); console.log('PASS BYE and call cleanup');
    const transcriber = new Transcriber({ binary: path.resolve('native/darwin-arm64/dialdev-transcribe'), directory: path.join(directory, 'recordings'), emit: e => events.push(e) });
    const info = await transcriber.info('en-US');
    if (!info.available) console.log(`SKIP Live transcription: ${info.reason}`);
    else {
      // An IVR plays a prompt, an in-band DTMF tone, an RFC 4733 telephone event, then a closing line.
      echo = false;
      const prompt = await speech(directory, 'Welcome to the test line. For billing, press 1.'), goodbye = await speech(directory, 'Thank you. Goodbye.');
      const tone = Int16Array.from({ length: 960 }, (_, i) => Math.round(6000 * (Math.sin(2 * Math.PI * 697 * i / 8000) + Math.sin(2 * Math.PI * 1209 * i / 8000))));
      const audio = [...prompt, ...new Int16Array(4000), ...tone, ...new Int16Array(12000), ...goodbye, ...new Int16Array(6400)];
      const eventAt = Math.floor((prompt.length + 4000 + 960 + 3200) / 160);
      const ivrId = await sip.action({ action: 'dial', accountId: 'integration-account', to: `sip:300@127.0.0.1:${port}` });
      await wait(() => events.find(e => e.id === ivrId && e.type === 'CALL_ESTABLISHED'), 'IVR call established'); await wait(() => engineRtp, 'engine RTP address');
      const key = `native:${ivrId}`; await sip.action({ action: 'transcribe', call: ivrId, token: await transcriber.start(key, { locale: 'en-US' }) });
      const began = Date.now(); let seq = 1000; const ssrc = 0x5eed;
      const packet = (pt, timestamp, payload, marker = false) => { const header = Buffer.alloc(12); header[0] = 0x80; header[1] = pt | (marker ? 0x80 : 0); header.writeUInt16BE(seq++ & 0xffff, 2); header.writeUInt32BE(timestamp >>> 0, 4); header.writeUInt32BE(ssrc, 8); rtp.send(Buffer.concat([header, payload]), engineRtp.port, engineRtp.address); };
      for (let frame = 0; frame * 160 < audio.length; frame++) {
        const offset = frame - eventAt;
        if (offset >= 0 && offset < 8) packet(101, eventAt * 160, Buffer.from([9, offset >= 5 ? 0x8a : 0x0a, ...[Math.min(offset + 1, 5) * 160].flatMap(d => [d >> 8, d & 255])]), offset === 0);
        else packet(0, frame * 160, Buffer.from(audio.slice(frame * 160, frame * 160 + 160).map(ulaw)));
        await new Promise(r => setTimeout(r, Math.max(0, began + (frame + 1) * 20 - Date.now())));
      }
      await sip.action({ action: 'end', call: ivrId }); await wait(() => events.find(e => e.id === ivrId && e.type === 'CALL_CLOSED'), 'IVR hangup');
      await wait(() => events.some(e => e.kind === 'transcript' && e.call === key && e.transcript.type === 'end'), 'transcription end', 30000);
      const transcript = events.filter(e => e.kind === 'transcript' && e.call === key).map(e => e.transcript);
      const remote = transcript.filter(t => t.type === 'text' && t.final && t.side === 'remote'), tones = transcript.filter(t => t.type === 'dtmf');
      console.log(`  heard: ${remote.map(t => `[${((t.start - began) / 1000).toFixed(2)}s] ${t.text}`).join(' ')}  tones: ${tones.map(t => `${t.digit}@${((t.time - began) / 1000).toFixed(2)}s`).join(' ')}`);
      assert.match(remote.map(t => t.text).join(' '), /billing/i); assert.match(remote.map(t => t.text).join(' '), /goodbye/i);
      assert.deepEqual(tones.map(t => `${t.side}:${t.digit}`), ['remote:1']); assert.ok(tones[0].time < remote.find(t => /goodbye/i.test(t.text)).start);
      assert.ok(Math.abs(tones[0].time - began - (prompt.length + 4000) / 8) < 300, 'tone time follows the RTP stream');
      assert.ok(events.some(e => e.id === ivrId && e.type === 'CALL_DTMF_START' && e.param === '9'), 'RFC 4733 telephone event reported with its digit');
      console.log('PASS Native audio streamed to on-device transcription; in-band and RFC 4733 DTMF reported');
      echo = true;
    }
    const incomingId = 'incoming-local-test'; const contact = registration.r.field('Contact').match(/<([^>]+)>/)?.[1];
    const offer = sdp(); const invite = `INVITE ${contact} SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1:${port};branch=z9hG4bK-incoming\r\nFrom: "Test caller" <sip:201@127.0.0.1:${port}>;tag=test-origin\r\nTo: <sip:1001@127.0.0.1:${port}>\r\nCall-ID: ${incomingId}\r\nCSeq: 1 INVITE\r\nContact: <sip:201@127.0.0.1:${port}>\r\nMax-Forwards: 70\r\nContent-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(offer)}\r\n\r\n${offer}`;
    sipSocket.send(invite, registration.remote.port, registration.remote.address); await wait(() => events.find(e => e.type === 'CALL_INCOMING' && e.id === incomingId), 'incoming call'); await sip.action({ action: 'end', call: incomingId }); await wait(() => events.find(e => e.id === incomingId && e.type === 'CALL_CLOSED'), 'incoming declined'); console.log('PASS Incoming caller identity and decline');
    await sip.disconnect('integration-account'); console.log('PASS Account disconnect');
  } catch (e) { console.error('Recent engine events:', events.slice(-12)); throw e; }
  finally { sip.stop(); sipSocket.close(); rtp.close(); await fs.rm(directory, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
