import { describe, expect, it } from 'vitest';
import { createDefaultOrderSettings, normalizeOrderSyncBaseUrl } from '../src/core/settings';

describe('order sync server address', () => {
  it('uses the public TTS-ERP HTTPS origin by default', () => {
    expect(createDefaultOrderSettings().syncBaseUrl).toBe('https://chen.daqiangplatform.com/tts');
  });

  it('migrates the old built-in address while preserving custom hosts', () => {
    expect(normalizeOrderSyncBaseUrl('https://daqiang.nat100.top/tts'))
      .toBe('https://chen.daqiangplatform.com/tts');
    expect(normalizeOrderSyncBaseUrl('http://daqiang.nat100.top/tts/'))
      .toBe('https://chen.daqiangplatform.com/tts');
    expect(normalizeOrderSyncBaseUrl('http://207.57.126.199:6007/'))
      .toBe('https://chen.daqiangplatform.com/tts');
    expect(normalizeOrderSyncBaseUrl('https://custom.example.test/tts'))
      .toBe('https://custom.example.test/tts');
  });
});
