import {
  SELLER_PAGE_COORDINATION_KEY,
  SELLER_PAGE_REQUEST_LEASE_MS,
} from './seller-page-coordination';
import { fetchTikTokResponse, type BoundTikTokResponse } from './tiktok-page-response';
import type { PageProxyRequestPayload } from './page-request-protocol';

export interface BoundPageRequest {
  tabId: number | undefined;
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
  method: 'GET' | 'POST';
  requestId: string;
  timeoutMs: number;
}

interface AvailableBoundPageAdapter {
  isAvailable(tabId: number | undefined): boolean;
  request(request: BoundPageRequest): Promise<BoundTikTokResponse>;
}

interface PageProxyAdapter extends AvailableBoundPageAdapter {
  cancel(request: BoundPageRequest): Promise<void>;
}

export interface BoundPageTransportAdapters {
  pageProxy: PageProxyAdapter;
  mainWorld: AvailableBoundPageAdapter;
  worker: Pick<AvailableBoundPageAdapter, 'request'>;
}

export interface BoundPageTransport {
  request(request: BoundPageRequest): Promise<BoundTikTokResponse>;
}

/**
 * Selects exactly one safe execution path for a Bound Page Request.
 * A page-side result is never replayed; only an unavailable page proxy may fall through.
 */
export function createBoundPageTransport(adapters: BoundPageTransportAdapters): BoundPageTransport {
  return {
    async request(request) {
      throwIfAborted(request.signal);
      if (adapters.pageProxy.isAvailable(request.tabId)) {
        try {
          return await adapters.pageProxy.request(request);
        } catch (error) {
          if (request.signal.aborted) {
            await adapters.pageProxy.cancel(request).catch(() => undefined);
            throw abortError();
          }
          if (!isPageProxyUnavailableError(error)) throw error;
        }
      }
      throwIfAborted(request.signal);
      if (adapters.mainWorld.isAvailable(request.tabId)) {
        return adapters.mainWorld.request(request);
      }
      return adapters.worker.request(request);
    },
  };
}

export function createChromeBoundPageTransport(): BoundPageTransport {
  return createBoundPageTransport({
    pageProxy: {
      isAvailable: (tabId) => typeof globalThis.chrome?.tabs?.sendMessage === 'function' && tabId !== undefined,
      request: requestThroughPageProxy,
      cancel: cancelPageProxyRequest,
    },
    mainWorld: {
      isAvailable: (tabId) => typeof globalThis.chrome?.scripting?.executeScript === 'function' && tabId !== undefined,
      request: requestThroughMainWorld,
    },
    worker: { request: requestThroughWorker },
  });
}

async function requestThroughPageProxy(request: BoundPageRequest): Promise<BoundTikTokResponse> {
  const tabId = requireTabId(request.tabId);
  const tabsApi = globalThis.chrome.tabs;
  const proxyRequest: PageProxyRequestPayload = {
    requestId: request.requestId,
    url: request.url,
    method: request.method,
    body: request.body,
    timeoutMs: request.timeoutMs,
  };
  let abortHandler: (() => void) | undefined;
  try {
    const execution = tabsApi.sendMessage(tabId, {
      type: 'order-sync:page-request',
      payload: proxyRequest,
    });
    const aborted = new Promise<never>((_, reject) => {
      abortHandler = () => reject(abortError());
      if (request.signal.aborted) abortHandler();
      else request.signal.addEventListener('abort', abortHandler, { once: true });
    });
    const bridgeResult = await Promise.race([execution, aborted]);
    throwIfAborted(request.signal);
    if (!isRecord(bridgeResult)) {
      throw Object.assign(new Error('页面请求代理未返回结果。'), { name: 'PageProxyResponseMissingError' });
    }
    if (bridgeResult.ok !== true) {
      const errorName = typeof bridgeResult.errorName === 'string'
        ? bridgeResult.errorName : 'PageProxyRequestError';
      const errorMessage = typeof bridgeResult.errorMessage === 'string'
        ? bridgeResult.errorMessage : '页面请求代理执行失败。';
      throw Object.assign(new Error(errorMessage), { name: errorName });
    }
    if (!isBoundTikTokResponse(bridgeResult.response)) {
      throw Object.assign(new Error('页面请求代理返回了无效响应。'), { name: 'PageProxyResponseInvalidError' });
    }
    return {
      ...materializePageProxyResponse(bridgeResult.response),
      requestMode: 'page_proxy',
    };
  } finally {
    if (abortHandler) request.signal.removeEventListener('abort', abortHandler);
  }
}

async function cancelPageProxyRequest(request: BoundPageRequest): Promise<void> {
  if (request.tabId === undefined || !globalThis.chrome?.tabs?.sendMessage) return;
  await globalThis.chrome.tabs.sendMessage(request.tabId, {
    type: 'order-sync:page-cancel',
    payload: { requestId: request.requestId },
  });
}

async function requestThroughMainWorld(request: BoundPageRequest): Promise<BoundTikTokResponse> {
  const tabId = requireTabId(request.tabId);
  let injected: chrome.scripting.InjectionResult<BoundTikTokResponse>[];
  let abortHandler: (() => void) | undefined;
  try {
    const execution = globalThis.chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: fetchTikTokResponse,
      args: [request.url, request.body, request.method, request.timeoutMs, null, true, {
        storageKey: SELLER_PAGE_COORDINATION_KEY,
        requestId: request.requestId,
        leaseMs: SELLER_PAGE_REQUEST_LEASE_MS,
      }],
    });
    const aborted = new Promise<never>((_, reject) => {
      abortHandler = () => reject(abortError());
      if (request.signal.aborted) abortHandler();
      else request.signal.addEventListener('abort', abortHandler, { once: true });
    });
    injected = await Promise.race([execution, aborted]);
  } catch (error) {
    if (request.signal.aborted) throw abortError();
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`executeScript TikTok 请求失败: ${sanitizeDiagnosticText(message).slice(0, 240)}`), {
      name: 'TikTokExecuteScriptError',
      cause: error,
    });
  } finally {
    if (abortHandler) request.signal.removeEventListener('abort', abortHandler);
  }
  throwIfAborted(request.signal);
  const result = injected[0]?.result;
  if (!isBoundTikTokResponse(result)) {
    throw Object.assign(new Error('绑定页面未返回可用的 TikTok 响应'), { name: 'TikTokBoundResponseMissingError' });
  }
  return { ...result, requestMode: 'main_execute_script' };
}

async function requestThroughWorker(request: BoundPageRequest): Promise<BoundTikTokResponse> {
  return {
    ...(await fetchTikTokResponse(request.url, request.body, request.method, request.signal)),
    requestMode: 'worker_fetch',
  };
}

function materializePageProxyResponse(response: BoundTikTokResponse): BoundTikTokResponse {
  if (response.payload !== null || typeof response.responseText !== 'string') return response;
  try {
    const payload = JSON.parse(response.responseText) as unknown;
    const { responseText: _responseText, ...withoutText } = response;
    return { ...withoutText, payload };
  } catch {
    return { ...response, responseReadError: response.responseReadError ?? 'response-not-json' };
  }
}

function isPageProxyUnavailableError(error: unknown): boolean {
  if (error instanceof Error && (
    error.name === 'PageProxyUnavailableError'
    || error.name === 'PageProxyResponseMissingError'
  )) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Receiving end does not exist|Could not establish connection|message port closed|no response was received/i.test(message);
}

function isBoundTikTokResponse(value: unknown): value is BoundTikTokResponse {
  return isRecord(value)
    && typeof value.ok === 'boolean'
    && typeof value.status === 'number'
    && 'payload' in value;
}

function requireTabId(tabId: number | undefined): number {
  if (tabId === undefined) throw new Error('Bound Page Request requires a Seller Center tab.');
  return tabId;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException('Request aborted', 'AbortError');
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|cookie|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
