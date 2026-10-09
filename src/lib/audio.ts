// Audio levels and devices for the meters on the phone screen and in Settings. Nothing here reaches the remote party.
import { useEffect, useRef, useState } from 'react';
import { errorText } from './utils';

/** Maps an RMS sample level to 0–1 on a −60…0 dBFS scale, which follows loudness the way people hear it. */
export const levelOf = (rms: number) => rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60)) : 0;

/** The live level (0–1) of a stream's audio, scaled by `gain`, or -1 while it has none. Peaks fall back gradually, like a VU meter. */
export function useLevel(stream?: MediaStream | null, gain = 1) {
  const [level, setLevel] = useState(-1); const gainRef = useRef(gain); gainRef.current = gain;
  const audible = !!stream?.getAudioTracks().length;
  useEffect(() => {
    if (!stream || !audible) { setLevel(-1); return; }
    const context = new AudioContext(); const analyser = context.createAnalyser(); analyser.fftSize = 1024;
    const source = context.createMediaStreamSource(stream); source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize); let shown = 0, last = 0, frame = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick); if (now - last < 50) return; last = now;
      analyser.getFloatTimeDomainData(samples); let sum = 0; for (const v of samples) sum += v * v;
      const value = levelOf(Math.sqrt(sum / samples.length) * gainRef.current);
      shown = value >= shown ? value : Math.max(value, shown - .06); setLevel(shown);
    };
    void context.resume(); frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); source.disconnect(); void context.close(); };
  }, [stream, audible]);
  return level;
}

/** Opens a microphone while `on`, for metering only. */
export function useMicrophone(on: boolean, deviceId: string) {
  const [state, setState] = useState<{ stream?: MediaStream; error?: string }>({});
  useEffect(() => {
    if (!on) { setState({}); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setState({ error: 'Microphone access is unavailable.' }); return; }
    let stream: MediaStream | undefined, cancelled = false;
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined } })
      .then(s => { if (cancelled) s.getTracks().forEach(t => t.stop()); else { stream = s; setState({ stream: s }); } })
      .catch(e => { if (!cancelled) setState({ error: errorText(e) }); });
    return () => { cancelled = true; stream?.getTracks().forEach(t => t.stop()); };
  }, [on, deviceId]);
  return state;
}

/** Audio and video devices, kept current as they are plugged in. Labels appear once microphone access is granted, so pass the open stream as `refresh`. */
export function useDevices(refresh?: unknown) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const update = () => { void navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {}); };
    update(); navigator.mediaDevices?.addEventListener('devicechange', update); return () => navigator.mediaDevices?.removeEventListener('devicechange', update);
  }, [refresh]);
  return devices;
}
/** A device's name without what Chromium appends to it: the USB vendor and product IDs, and "(Built-in)". */
export const deviceName = (label: string) => label.replace(/^Default\s*-\s*/, '').replace(/\s*\((?:[0-9a-f]{4}:[0-9a-f]{4}|Built-in)\)/gi, '').trim();
export const deviceOptions = (devices: MediaDeviceInfo[], kind: MediaDeviceKind, fallback: string) => devices.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default').map((d, i) => ({ id: d.deviceId, label: deviceName(d.label) || `${fallback} ${i + 1}` }));

/** Plays a short tone on `output` at `volume`. Returns the tone's stream, for metering, once it is playing; it stops by itself. */
export async function playTestTone(output: string, volume: number, onEnd?: () => void) {
  const context = new AudioContext(); const destination = context.createMediaStreamDestination(); const oscillator = context.createOscillator(); const gain = context.createGain();
  gain.gain.value = .12 * volume; oscillator.frequency.value = 880; oscillator.connect(gain).connect(destination);
  const audio = new Audio(); audio.srcObject = destination.stream;
  const stop = () => { oscillator.stop(); audio.pause(); audio.srcObject = null; void context.close(); onEnd?.(); };
  try { if (output && audio.setSinkId) await audio.setSinkId(output); await audio.play(); oscillator.start(); }
  catch (error) { void context.close(); throw error; }
  setTimeout(stop, 900);
  return destination.stream;
}
