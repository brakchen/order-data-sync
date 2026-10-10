import { describe, expect, it } from 'vitest';
import { createDefaultOrderSettings, normalizeOrderSyncBaseUrl } from '../src/core/settings';

describe('order sync server address', () => {
  it('uses the new TTS-ERP IP by default', () => {
    expect(createDefaultOrderSettings().syncBaseUrl).toBe('http://207.57.126.199:6007');
  });

  it('migrates the old built-in address while preserving custom hosts', () => {
    expect(normalizeOrderSyncBaseUrl('https://daqiang.nat100.top/tts'))
      .toBe('http://207.57.126.199:6007');
    expect(normalizeOrderSyncBaseUrl('http://daqiang.nat100.top/tts/'))
      .toBe('http://207.57.126.199:6007');
    expect(normalizeOrderSyncBaseUrl('https://custom.example.test/tts'))
      .toBe('https://custom.example.test/tts');
  });
});
