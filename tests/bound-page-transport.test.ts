import { describe, expect, it, vi } from 'vitest';
import {
  createBoundPageTransport,
  type BoundPageTransportAdapters,
} from '../src/extension/bound-page-transport';
import type { BoundTikTokResponse } from '../src/extension/tiktok-page-response';

const response = (requestMode: BoundTikTokResponse['requestMode']): BoundTikTokResponse => ({
  ok: true,
  status: 200,
  payload: { source: requestMode },
  requestMode,
});

function adapters(overrides: Partial<BoundPageTransportAdapters> = {}): BoundPageTransportAdapters {
  return {
    pageProxy: {
      isAvailable: () => true,
      request: vi.fn(async () => response('page_proxy')),
      cancel: vi.fn(async () => undefined),
    },
    mainWorld: {
      isAvailable: () => true,
      request: vi.fn(async () => response('main_execute_script')),
    },
    worker: {
      request: vi.fn(async () => response('worker_fetch')),
    },
    ...overrides,
  };
}

const request = {
  tabId: 7,
  url: 'https://seller.tiktokglobalshop.com/api/orders',
  body: {},
  method: 'POST' as const,
  signal: new AbortController().signal,
  requestId: 'request-1',
  timeoutMs: 30_000,
};

describe('Bound Page Request transport', () => {
  it('uses MAIN-world only when the page proxy is unavailable', async () => {
    const mainRequest = vi.fn(async () => response('main_execute_script'));
    const transport = createBoundPageTransport(adapters({
      pageProxy: {
        isAvailable: () => true,
        request: vi.fn(async () => {
          throw Object.assign(new Error('no receiver'), { name: 'PageProxyUnavailableError' });
        }),
        cancel: vi.fn(async () => undefined),
      },
      mainWorld: { isAvailable: () => true, request: mainRequest },
    }));

    await expect(transport.request(request)).resolves.toMatchObject({ requestMode: 'main_execute_script' });
    expect(mainRequest).toHaveBeenCalledOnce();
  });

  it('does not replay a request after a page-side timeout', async () => {
    const mainRequest = vi.fn(async () => response('main_execute_script'));
    const workerRequest = vi.fn(async () => response('worker_fetch'));
    const transport = createBoundPageTransport(adapters({
      pageProxy: {
        isAvailable: () => true,
        request: vi.fn(async () => {
          throw Object.assign(new Error('page bridge timed out'), { name: 'PageProxyTimeoutError' });
        }),
        cancel: vi.fn(async () => undefined),
      },
      mainWorld: { isAvailable: () => true, request: mainRequest },
      worker: { request: workerRequest },
    }));

    await expect(transport.request(request)).rejects.toMatchObject({ name: 'PageProxyTimeoutError' });
    expect(mainRequest).not.toHaveBeenCalled();
    expect(workerRequest).not.toHaveBeenCalled();
  });

  it('uses the worker adapter when no bound-page adapter is available', async () => {
    const workerRequest = vi.fn(async () => response('worker_fetch'));
    const transport = createBoundPageTransport(adapters({
      pageProxy: { isAvailable: () => false, request: vi.fn(), cancel: vi.fn() },
      mainWorld: { isAvailable: () => false, request: vi.fn() },
      worker: { request: workerRequest },
    }));

    await expect(transport.request({ ...request, tabId: undefined })).resolves.toMatchObject({ requestMode: 'worker_fetch' });
    expect(workerRequest).toHaveBeenCalledOnce();
  });
});
