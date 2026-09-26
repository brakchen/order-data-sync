import { defineContentScript } from 'wxt/utils/define-content-script';
import { fetchTikTokResponse } from '../src/extension/tiktok-page-response';
import {
  isPageProxyCancelPayload,
  isPageProxyRequestPayload,
  ORDER_IDENTITY_SOURCE,
  ORDER_PAGE_PROXY_CANCEL,
  ORDER_PAGE_PROXY_REQUEST,
  ORDER_PAGE_PROXY_RESPONSE,
  ORDER_PAGE_PROXY_SOURCE,
  PAGE_PROXY_READY_FLAG,
} from '../src/extension/page-request-protocol';

const READY_FLAG = '__tiktokOrderSyncIdentityHookReadyV1';
const ORDER_PATHS = new Set([
  '/api/fulfillment/order/list',
  '/api/v1/fulfillment/logistic_detail/list',
  '/api/v1/pay/statement/list/detail',
  '/api/v1/pay/statement/transaction/detail',
]);
const SELLER_CENTER_ORIGINS = new Set([
  'https://seller.tiktokglobalshop.com',
  'https://seller.tiktokshopglobalselling.com',
  'https://api16-normal-sg.tiktokshopglobalselling.com',
]);

export default defineContentScript({
  matches: [
    'https://seller.tiktokglobalshop.com/*',
    'https://seller.tiktokshopglobalselling.com/*',
    'https://api16-normal-sg.tiktokshopglobalselling.com/*',
  ],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const win = window as unknown as Record<string, unknown>;
    if (!win[READY_FLAG]) {
      win[READY_FLAG] = true;
      installIdentityHooks();
    }
    installPageProxy();
  },
});

function installIdentityHooks(): void {
  const seen = new Set<string>();
  const report = (rawUrl: string, method: string) => {
    if (method.toUpperCase() !== 'POST' && method.toUpperCase() !== 'GET') return;
    try {
      const url = new URL(rawUrl, window.location.origin);
      if (!SELLER_CENTER_ORIGINS.has(url.origin) || !ORDER_PATHS.has(url.pathname)) return;
      const sellerId = url.searchParams.get('oec_seller_id')?.trim()
        || url.searchParams.get('seller_id')?.trim();
      if (!sellerId) return;
      const key = `${url.origin}|${url.pathname}|${sellerId}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 64) seen.delete(seen.values().next().value!);
      window.postMessage({
        source: ORDER_IDENTITY_SOURCE,
        type: 'seller-observed',
        payload: {
          sellerId,
          url: window.location.href,
          ...(url.searchParams.get('aadvid') ? { advertiserId: url.searchParams.get('aadvid') } : {}),
        },
      }, '*');
    } catch {
      // Invalid observed URLs do not become binding state.
    }
  };

  const originalFetch = window.fetch;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input
      : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    report(rawUrl, method);
    return originalFetch(input, init);
  };

  const originalOpen = XMLHttpRequest.prototype.open as unknown as (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) => void;
  const requests = new WeakMap<XMLHttpRequest, { url: string; method: string }>();
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...rest: unknown[]) {
    requests.set(this, { url: String(url), method });
    return originalOpen.apply(this, [method, url, ...rest]);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
    const request = requests.get(this);
    if (request) report(request.url, request.method);
    return originalSend.call(this, body);
  };
}

function installPageProxy(): void {
  const flags = window as unknown as Record<string, unknown>;
  if (flags[PAGE_PROXY_READY_FLAG]) return;
  flags[PAGE_PROXY_READY_FLAG] = true;
  const active = new Map<string, AbortController>();
  window.addEventListener('message', (event) => {
    if (event.source !== window || !isRecord(event.data)
      || event.data.source !== ORDER_PAGE_PROXY_SOURCE) return;
    if (event.data.type === ORDER_PAGE_PROXY_CANCEL && isPageProxyCancelPayload(event.data.payload)) {
      active.get(event.data.payload.requestId)?.abort();
      return;
    }
    if (event.data.type !== ORDER_PAGE_PROXY_REQUEST || !isPageProxyRequestPayload(event.data.payload)) return;
    const request = event.data.payload;
    if (active.has(request.requestId)) return;
    const controller = new AbortController();
    active.set(request.requestId, controller);
    void fetchTikTokResponse(request.url, request.body, request.method, controller.signal, request.timeoutMs, false)
      .then((response) => window.postMessage({
        source: ORDER_PAGE_PROXY_SOURCE,
        type: ORDER_PAGE_PROXY_RESPONSE,
        payload: { requestId: request.requestId, ok: true, response },
      }, '*'), (error: unknown) => window.postMessage({
        source: ORDER_PAGE_PROXY_SOURCE,
        type: ORDER_PAGE_PROXY_RESPONSE,
        payload: {
          requestId: request.requestId,
          ok: false,
          errorName: error instanceof Error ? error.name : 'TikTokPageRequestError',
          errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 240),
        },
      }, '*')).finally(() => active.delete(request.requestId));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
