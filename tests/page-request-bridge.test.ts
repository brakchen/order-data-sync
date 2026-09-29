/** @vitest-environment jsdom */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORDER_PAGE_PROXY_CANCEL,
  ORDER_PAGE_PROXY_READY,
  ORDER_PAGE_PROXY_REQUEST,
  ORDER_PAGE_PROXY_RESPONSE,
  ORDER_PAGE_PROXY_SOURCE,
  type PageProxyResponsePayload,
} from '../src/extension/page-request-protocol';

const contentHarness = vi.hoisted(() => ({
  main: null as null | (() => void),
}));

vi.mock('wxt/utils/define-content-script', () => ({
  defineContentScript: (config: { main: () => void }) => {
    contentHarness.main = config.main;
    return config;
  },
}));

import '../entrypoints/content';

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

let runtimeListener: RuntimeListener;

function dispatchWindowMessage(data: unknown): void {
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: window });
  window.dispatchEvent(event);
}

function proxyRequest(timeoutMs: number) {
  return {
    type: 'order-sync:page-request',
    payload: {
      requestId: `request-${timeoutMs}`,
      url: 'https://seller.tiktokglobalshop.com/api/fulfillment/order/list',
      method: 'POST' as const,
      body: {},
      timeoutMs,
    },
  };
}

beforeAll(() => {
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: vi.fn((listener: RuntimeListener) => { runtimeListener = listener; }),
      },
      sendMessage: vi.fn(async () => undefined),
    },
  } as unknown as typeof chrome;
  contentHarness.main?.();
  dispatchWindowMessage({ source: ORDER_PAGE_PROXY_SOURCE, type: ORDER_PAGE_PROXY_READY });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  delete (globalThis as { chrome?: typeof chrome }).chrome;
});

describe('isolated page request bridge', () => {
  it('uses the request timeout plus transport margin and cancels MAIN-world work', async () => {
    const request = proxyRequest(60_000);
    const sendResponse = vi.fn();

    expect(runtimeListener(request, {} as chrome.runtime.MessageSender, sendResponse)).toBe(true);
    expect(window.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: ORDER_PAGE_PROXY_REQUEST,
      payload: request.payload,
    }), '*');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendResponse).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(window.postMessage).toHaveBeenCalledWith({
      source: ORDER_PAGE_PROXY_SOURCE,
      type: ORDER_PAGE_PROXY_CANCEL,
      payload: { requestId: request.payload.requestId },
    }, '*');
    expect(sendResponse).toHaveBeenCalledOnce();
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      errorName: 'PageProxyTimeoutError',
    }));

    dispatchWindowMessage({
      source: ORDER_PAGE_PROXY_SOURCE,
      type: ORDER_PAGE_PROXY_RESPONSE,
      payload: {
        requestId: request.payload.requestId,
        ok: true,
        response: { ok: true, status: 200, payload: { code: 0 } },
      } satisfies PageProxyResponsePayload,
    });
    expect(sendResponse).toHaveBeenCalledOnce();
  });

  it('clears the watchdog after a normal page response', async () => {
    const request = proxyRequest(30_000);
    const sendResponse = vi.fn();

    runtimeListener(request, {} as chrome.runtime.MessageSender, sendResponse);
    dispatchWindowMessage({
      source: ORDER_PAGE_PROXY_SOURCE,
      type: ORDER_PAGE_PROXY_RESPONSE,
      payload: {
        requestId: request.payload.requestId,
        ok: true,
        response: { ok: true, status: 200, payload: { code: 0 } },
      } satisfies PageProxyResponsePayload,
    });

    expect(sendResponse).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(window.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: ORDER_PAGE_PROXY_CANCEL,
    }), '*');
    expect(sendResponse).toHaveBeenCalledOnce();
  });
});
