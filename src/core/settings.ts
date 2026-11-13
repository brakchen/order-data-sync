export const ORDER_SYNC_STATE_KEY = 'orderSyncState';
export const ORDER_RUNTIME_LOG_LIMIT = 5_000;
export const DEFAULT_ORDER_SYNC_BASE_URL = 'https://chen.daqiangplatform.com/tts';

import type { OrderSyncSettings } from './types';

export function createDefaultOrderSettings(): OrderSyncSettings {
  return {
    syncBaseUrl: DEFAULT_ORDER_SYNC_BASE_URL,
    syncToken: '',
    syncPaused: false,
    orderDomainSyncEnabled: true,
  };
}

export function normalizeOrderSyncBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '');
    if (
      (host === 'daqiang.nat100.top' && path === '/tts' && (url.port === '' || url.port === '80' || url.port === '443'))
      || (host === '207.57.126.199' && (url.port === '6007' || url.port === ''))
    ) {
      return DEFAULT_ORDER_SYNC_BASE_URL;
    }
    if (url.protocol === 'http:' && host === 'daqiang.nat100.top'
      && (url.port === '' || url.port === '80')) {
      url.protocol = 'https:';
      url.port = '';
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    // Preserve malformed/custom input for the settings UI to report.
  }
  return trimmed;
}

export function normalizeOrderSyncSettings(value: unknown): OrderSyncSettings {
  const defaults = createDefaultOrderSettings();
  if (!isRecord(value)) return defaults;
  return {
    syncBaseUrl: typeof value.syncBaseUrl === 'string'
      ? normalizeOrderSyncBaseUrl(value.syncBaseUrl)
      : defaults.syncBaseUrl,
    syncToken: typeof value.syncToken === 'string' ? value.syncToken : '',
    syncPaused: value.syncPaused === true,
    orderDomainSyncEnabled: value.orderDomainSyncEnabled !== false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
