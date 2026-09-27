import { defineContentScript } from 'wxt/utils/define-content-script';
import { fetchTikTokResponse } from '../src/extension/tiktok-page-response';
import {
  isPageProxyCancelPayload,
  isPageProxyRequestPayload,
  ORDER_IDENTITY_SOURCE,
  ORDER_PAGE_PROXY_CANCEL,
  ORDER_PAGE_PROXY_REQUEST,
  ORDER_PAGE_PROXY_RESPONSE,
  ORDER_PAGE_PROXY_READY,
  ORDER_PAGE_PROXY_SOURCE,
  PAGE_PROXY_READY_FLAG,
} from '../src/extension/page-request-protocol';
import {
  SELLER_PAGE_COORDINATION_KEY,
  SELLER_PAGE_REQUEST_LEASE_MS,
} from '../src/extension/seller-page-coordination';

const READY_FLAG = '__tiktokOrderSyncIdentityHookReadyV1';
const SELLER_ID_ENDPOINT_PATH = '/api/v3/seller/common/get';
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
    window.postMessage({ source: ORDER_PAGE_PROXY_SOURCE, type: ORDER_PAGE_PROXY_READY }, '*');
  },
});

function installIdentityHooks(): void {
  const seen = new Set<string>();
  const publishSellerIdentity = (rawUrl: string, payload: unknown) => {
    if (!isSellerIdentityResponse(payload)) return;
    const seller = payload.data.seller;
    const sellerId = seller.seller_id.trim();
    const key = `${sellerId}|${seller.shop_code ?? ''}`;
    if (seen.has(key)) return;
    // Deduplicate consecutive observations, but allow A -> B -> A when the
    // user switches shops in the same Seller Center tab.
    seen.clear();
    seen.add(key);
    window.postMessage({
      source: ORDER_IDENTITY_SOURCE,
      type: 'seller-observed',
      payload: {
        sellerId,
        url: window.location.href,
        ...(seller.shop_name ? { shopName: seller.shop_name } : {}),
        ...(seller.shop_code ? { shopCode: seller.shop_code } : {}),
        ...(seller.shop_region ? { shopRegion: seller.shop_region } : {}),
        ...(seller.region_code ? { regionCode: seller.region_code } : {}),
        ...(new URL(rawUrl, window.location.origin).searchParams.get('aadvid')
          ? { advertiserId: new URL(rawUrl, window.location.origin).searchParams.get('aadvid')! }
          : {}),
      },
    }, '*');
  };

  const inspectFetchResponse = async (rawUrl: string, response: Response) => {
    if (!isSellerIdentityEndpoint(rawUrl, response.status)) return;
    try {
      publishSellerIdentity(rawUrl, await response.clone().json());
    } catch {
      // Non-JSON or failed responses do not contain a usable seller identity.
    }
  };

  const inspectXhrResponse = (rawUrl: string, status: number, response: unknown) => {
    if (!isSellerIdentityEndpoint(rawUrl, status)) return;
    try {
      publishSellerIdentity(rawUrl, typeof response === 'string' ? JSON.parse(response) : response);
    } catch {
      // Non-JSON or failed responses do not contain a usable seller identity.
    }
  };

  const originalFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input
      : input instanceof URL ? input.href : input.url;
    const response = await originalFetch(input, init);
    void inspectFetchResponse(rawUrl, response);
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open as unknown as (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) => void;
  const requests = new WeakMap<XMLHttpRequest, { url: string }>();
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...rest: unknown[]) {
    requests.set(this, { url: String(url) });
    return originalOpen.apply(this, [method, url, ...rest]);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
    const request = requests.get(this);
    if (request) {
      this.addEventListener('load', () => {
        let response: unknown = this.response;
        if (this.responseType === '' || this.responseType === 'text') response = this.responseText;
        inspectXhrResponse(request.url, this.status, response);
      }, { once: true });
    }
    return originalSend.call(this, body);
  };
}

function isSellerIdentityEndpoint(rawUrl: string, status: number): boolean {
  if (status < 200 || status >= 300) return false;
  try {
    const url = new URL(rawUrl, window.location.origin);
    return SELLER_CENTER_ORIGINS.has(url.origin) && url.pathname === SELLER_ID_ENDPOINT_PATH;
  } catch {
    return false;
  }
}

function isSellerIdentityResponse(value: unknown): value is {
  code: number;
  data: { seller: {
    seller_id: string;
    shop_name?: string;
    shop_code?: string;
    shop_region?: string;
    region_code?: string;
  } };
} {
  if (!isRecord(value) || value.code !== 0 || !isRecord(value.data) || !isRecord(value.data.seller)) return false;
  const seller = value.data.seller;
  return typeof seller.seller_id === 'string' && seller.seller_id.trim().length > 0
    && (seller.shop_name === undefined || typeof seller.shop_name === 'string')
    && (seller.shop_code === undefined || typeof seller.shop_code === 'string')
    && (seller.shop_region === undefined || typeof seller.shop_region === 'string')
    && (seller.region_code === undefined || typeof seller.region_code === 'string');
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
    void fetchTikTokResponse(
      request.url,
      request.body,
      request.method,
      controller.signal,
      request.timeoutMs,
      false,
      {
        storageKey: SELLER_PAGE_COORDINATION_KEY,
        requestId: request.requestId,
        leaseMs: SELLER_PAGE_REQUEST_LEASE_MS,
      },
    )
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
