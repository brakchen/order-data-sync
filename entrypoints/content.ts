import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  isPageProxyCancelPayload,
  isPageProxyRequestPayload,
  isPageProxyResponsePayload,
  ORDER_PAGE_PROXY_CANCEL,
  ORDER_PAGE_PROXY_REQUEST,
  ORDER_PAGE_PROXY_RESPONSE,
  ORDER_PAGE_PROXY_READY,
  ORDER_PAGE_PROXY_SOURCE,
  ORDER_IDENTITY_SOURCE,
} from '../src/extension/page-request-protocol';

export default defineContentScript({
  matches: [
    'https://seller.tiktokglobalshop.com/*',
    'https://seller.tiktokshopglobalselling.com/*',
    'https://api16-normal-sg.tiktokshopglobalselling.com/*',
  ],
  runAt: 'document_start',
  main() {
    let pageProxyReady = false;
    window.addEventListener('message', (event) => {
      if (event.source === window && isRecord(event.data)
        && event.data.source === ORDER_PAGE_PROXY_SOURCE
        && event.data.type === ORDER_PAGE_PROXY_READY) {
        pageProxyReady = true;
      }
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const value = message as { type?: unknown; payload?: unknown } | undefined;
      if (value?.type === 'order-sync:page-cancel' && isPageProxyCancelPayload(value.payload)) {
        window.postMessage({ source: ORDER_PAGE_PROXY_SOURCE, type: ORDER_PAGE_PROXY_CANCEL, payload: value.payload }, '*');
        return false;
      }
      if (value?.type !== 'order-sync:page-request' || !isPageProxyRequestPayload(value.payload)) return false;
      if (!pageProxyReady) {
        sendResponse({ ok: false, errorName: 'PageProxyUnavailableError', errorMessage: '订单插件页面代理尚未就绪。' });
        return false;
      }
      const request = value.payload;
      const cleanup = (listener: (event: MessageEvent<unknown>) => void, timer: ReturnType<typeof setTimeout>) => {
        window.removeEventListener('message', listener);
        clearTimeout(timer);
      };
      const listener = (event: MessageEvent<unknown>) => {
        if (event.source !== window || !isRecord(event.data)
          || event.data.source !== ORDER_PAGE_PROXY_SOURCE
          || event.data.type !== ORDER_PAGE_PROXY_RESPONSE
          || !isPageProxyResponsePayload(event.data.payload)
          || event.data.payload.requestId !== request.requestId) return;
        cleanup(listener, timeout);
        sendResponse(event.data.payload.ok
          ? { ok: true, response: event.data.payload.response }
          : event.data.payload);
      };
      const timeout = setTimeout(() => {
        cleanup(listener, timeout);
        sendResponse({ ok: false, errorName: 'PageProxyTimeoutError', errorMessage: '订单请求超过 30 秒未响应。' });
      }, 30_000);
      window.addEventListener('message', listener);
      window.postMessage({ source: ORDER_PAGE_PROXY_SOURCE, type: ORDER_PAGE_PROXY_REQUEST, payload: request }, '*');
      return true;
    });

    window.addEventListener('message', (event) => {
      if (event.source !== window || !isRecord(event.data)
        || event.data.source !== ORDER_IDENTITY_SOURCE
        || event.data.type !== 'seller-observed'
        || !isSellerIdentity(event.data.payload)) return;
      void chrome.runtime.sendMessage({ type: 'order-sync:capture-seller', payload: event.data.payload }).catch(() => undefined);
    });
  },
});

function isSellerIdentity(value: unknown): value is { sellerId: string; url: string; advertiserId?: string } {
  if (!isRecord(value) || typeof value.sellerId !== 'string' || !value.sellerId.trim()
    || typeof value.url !== 'string') return false;
  try {
    const url = new URL(value.url);
    return (url.origin === 'https://seller.tiktokglobalshop.com'
      || url.origin === 'https://seller.tiktokshopglobalselling.com')
      && (value.advertiserId === undefined || typeof value.advertiserId === 'string');
  } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
