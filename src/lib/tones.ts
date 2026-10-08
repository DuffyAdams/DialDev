// Locally generated feedback tones. Nothing here is sent to the remote party; DTMF signalling is handled by the phone engine.
const dtmfPairs: Record<string, [number, number]> = { '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], '*': [941, 1209], '0': [941, 1336], '#': [941, 1477] };
let shared: AudioContext | undefined;
const context = () => { shared ??= new AudioContext(); if (shared.state === 'suspended') void shared.resume(); return shared; };

function play(frequencies: number[], start: number, length: number, volume: number, audio: AudioContext) {
  for (const frequency of frequencies) {
    const oscillator = audio.createOscillator(); const gain = audio.createGain(); oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(volume, start + .01); gain.gain.setValueAtTime(volume, start + length - .02); gain.gain.linearRampToValueAtTime(0, start + length);
    oscillator.connect(gain).connect(audio.destination); oscillator.start(start); oscillator.stop(start + length + .01);
  }
}
export function keyTone(key: string) { const pair = dtmfPairs[key]; if (!pair) return; try { const audio = context(); play(pair, audio.currentTime, .12, .035, audio); } catch { /* Audio output is optional feedback. */ } }
/** Starts a repeating ring and returns a function that stops it. */
export function ring(): () => void {
  let audio: AudioContext;
  try { audio = new AudioContext(); } catch { return () => {}; }
  const burst = () => { if (audio.state === 'suspended') void audio.resume(); const now = audio.currentTime; play([440, 480], now, .9, .05, audio); play([440, 480], now + 1.1, .9, .05, audio); };
  burst(); const timer = setInterval(burst, 4000);
  return () => { clearInterval(timer); void audio.close(); };
}
