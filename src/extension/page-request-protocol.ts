import type { BoundTikTokResponse } from './tiktok-page-response';

/** Window-message protocol shared by the MAIN-world page hook and isolated bridge. */
export const ORDER_PAGE_PROXY_SOURCE = 'tiktok-order-sync-page-proxy-v1';
export const ORDER_PAGE_PROXY_REQUEST = 'request';
export const ORDER_PAGE_PROXY_RESPONSE = 'response';
export const ORDER_PAGE_PROXY_CANCEL = 'cancel';
export const PAGE_PROXY_READY_FLAG = '__tiktokOrderSyncPageProxyReadyV1';
export const ORDER_IDENTITY_SOURCE = 'tiktok-order-sync-identity-v1';

export type PageProxyRequestPayload = {
  requestId: string;
  url: string;
  method: 'GET' | 'POST';
  body: Record<string, unknown>;
  timeoutMs: number;
};

export type PageProxyCancelPayload = { requestId: string };

export type PageProxyResponsePayload =
  | { requestId: string; ok: true; response: BoundTikTokResponse }
  | { requestId: string; ok: false; errorName: string; errorMessage: string };

const SELLER_CENTER_ORIGINS = new Set([
  'https://seller.tiktokglobalshop.com',
  'https://seller.tiktokshopglobalselling.com',
  'https://api16-normal-sg.tiktokshopglobalselling.com',
]);
const ALLOWED_PATH_PREFIXES = ['/oec_ads/', '/api/'] as const;

export function isPageProxyRequestPayload(value: unknown): value is PageProxyRequestPayload {
  if (!isRecord(value)
    || typeof value.requestId !== 'string'
    || value.requestId.length === 0
    || typeof value.url !== 'string'
    || (value.method !== 'GET' && value.method !== 'POST')
    || !isRecord(value.body)
    || typeof value.timeoutMs !== 'number'
    || !Number.isFinite(value.timeoutMs)
    || value.timeoutMs <= 0
    || value.timeoutMs > 120_000) return false;
  try {
    const url = new URL(value.url);
    return SELLER_CENTER_ORIGINS.has(url.origin)
      && ALLOWED_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

export function isPageProxyCancelPayload(value: unknown): value is PageProxyCancelPayload {
  return isRecord(value) && typeof value.requestId === 'string' && value.requestId.length > 0;
}

export function isPageProxyResponsePayload(value: unknown): value is PageProxyResponsePayload {
  if (!isRecord(value) || typeof value.requestId !== 'string' || value.requestId.length === 0) return false;
  if (value.ok === true) return isRecord(value.response)
    && typeof value.response.ok === 'boolean'
    && typeof value.response.status === 'number'
    && 'payload' in value.response;
  return value.ok === false
    && typeof value.errorName === 'string'
    && typeof value.errorMessage === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
