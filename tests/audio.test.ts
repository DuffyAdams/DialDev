import { describe, expect, it } from 'vitest';
import { deviceName } from '../src/lib/audio';

describe('device names', () => {
  it('drops the USB IDs, "(Built-in)" and the default prefix that Chromium adds', () => {
    expect(deviceName('Yeti Stereo Microphone (046d:0ab1)')).toBe('Yeti Stereo Microphone');
    expect(deviceName('USB PnP Sound Device (08bb:2902)')).toBe('USB PnP Sound Device');
    expect(deviceName('MacBook Air Microphone (Built-in)')).toBe('MacBook Air Microphone');
    expect(deviceName('Default - Yeti Stereo Microphone (046d:0ab1)')).toBe('Yeti Stereo Microphone');
    expect(deviceName('Duffy Adams’s iPhone Microphone')).toBe('Duffy Adams’s iPhone Microphone');
  });
});
