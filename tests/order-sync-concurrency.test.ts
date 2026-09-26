import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderSyncState } from '../src/core/types';
import { createDefaultOrderProgress, createDefaultOrderSyncState } from '../src/extension/storage';

const harness = vi.hoisted(() => ({
  state: null as OrderSyncState | null,
  uploads: [] as Array<{ token: string; dump: unknown }>,
}));

vi.mock('../src/extension/storage', async () => {
  const actual = await vi.importActual<typeof import('../src/extension/storage')>('../src/extension/storage');
  let mutationTail: Promise<unknown> = Promise.resolve();
  const runOrderSyncStateMutation = <T>(mutation: () => Promise<T>): Promise<T> => {
    const task = mutationTail.then(mutation, mutation);
    mutationTail = task.then(() => undefined, () => undefined);
    return task;
  };
  const saveOrderSyncState = async (state: OrderSyncState) => {
    harness.state = structuredClone(state);
  };
  return {
    ...actual,
    getOrderSyncState: async () => structuredClone(harness.state!),
    getOrderSyncStateWithinMutation: async () => structuredClone(harness.state!),
    runOrderSyncStateMutation,
    saveOrderSyncState,
    mutateOrderSyncState: (mutation: (state: OrderSyncState) => OrderSyncState | Promise<OrderSyncState>) =>
      runOrderSyncStateMutation(async () => {
        const next = await mutation(structuredClone(harness.state!));
        await saveOrderSyncState(next);
        return structuredClone(next);
      }),
  };
});

vi.mock('../src/core/order-sync', async () => {
  const actual = await vi.importActual<typeof import('../src/core/order-sync')>('../src/core/order-sync');
  return {
    ...actual,
    fetchOrderSyncReconciliation: vi.fn(async () => null),
    hasDataBulk: vi.fn(async () => ({ covered: {} })),
    uploadOrderSyncDump: vi.fn(async (settings: { syncToken: string }, _scope: unknown, dump: unknown) => {
      harness.uploads.push({ token: settings.syncToken, dump });
      return { requestId: 'test-upload' };
    }),
  };
});

vi.mock('../src/core/request-rate-limiter', () => ({
  ACCELERATED_REQUEST_INTERVAL_MS: 0,
  ACCELERATED_REQUEST_MAX_IN_FLIGHT: 8,
  createRequestRateLimiter: () => ({ acquire: async () => () => undefined }),
}));

import { handleOrderSyncAlarm } from '../src/extension/order-engine';

function stateFor(sellerId: string): OrderSyncState {
  const base = createDefaultOrderSyncState();
  return {
    ...base,
    settings: { ...base.settings, syncToken: `token-${sellerId}` },
    boundTab: {
      tabId: 7,
      url: 'https://seller.tiktokglobalshop.com/orders',
      sellerId,
    },
  };
}

function pageResult(payload: unknown, status = 200) {
  return [{ result: { ok: status >= 200 && status < 300, status, payload } }];
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.state = stateFor('seller-A');
  harness.uploads = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({ orderSyncState: structuredClone(harness.state) })),
        set: vi.fn(async (value: { orderSyncState: OrderSyncState }) => {
          harness.state = structuredClone(value.orderSyncState);
        }),
      },
    },
    alarms: {
      get: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => false),
    },
    scripting: {
      executeScript: vi.fn(async () => pageResult({
        code: 0,
        data: { main_orders: [], has_more: false, total_count: 0 },
      })),
    },
  } as unknown as typeof chrome;
});

afterEach(() => vi.useRealTimers());

describe('order domain concurrent scope changes', () => {
  it('does not upload an old seller page into the newly bound seller', async () => {
    vi.mocked(chrome.scripting.executeScript).mockImplementation(async () => {
      harness.state = stateFor('seller-B');
      return pageResult({
        code: 0,
        data: { main_orders: [{ main_order_id: 'A-order-1' }], has_more: false, total_count: 1 },
      }) as never;
    });

    await handleOrderSyncAlarm();

    expect(harness.uploads).toEqual([]);
    expect(harness.state?.boundTab?.sellerId).toBe('seller-B');
    expect(harness.state?.orderProgress.domains.orders.uploaded).toBe(0);
    expect(harness.state?.orderProgress.domains.orders.snapshotKeys).toEqual([]);
  });

  it('does not clear a new seller binding when an old request returns 401', async () => {
    vi.mocked(chrome.scripting.executeScript).mockImplementation(async () => {
      harness.state = stateFor('seller-B');
      return pageResult({ code: 11000 }, 401) as never;
    });

    await handleOrderSyncAlarm();

    expect(harness.state?.boundTab?.sellerId).toBe('seller-B');
  });

  it('keeps the order domain done while its logistics consumer is still running', async () => {
    let resolveLogistics!: (result: ReturnType<typeof pageResult>) => void;
    vi.mocked(chrome.scripting.executeScript).mockImplementation(async (options) => {
      const url = String(options.args?.[0] ?? '');
      if (url.includes('logistic_detail')) {
        return new Promise((resolve) => { resolveLogistics = resolve; }) as never;
      }
      if (url.includes('/api/fulfillment/order/get')) {
        return pageResult({
          code: 0,
          message: 'success',
          data: { main_order: [{ main_order_id: 'A-order-1' }] },
        }) as never;
      }
      if (url.includes('/api/v1/fulfillment/order/history')) {
        return pageResult({
          code: 0,
          message: 'success',
          data: { total_count: 0, order_history: [] },
        }) as never;
      }
      return pageResult({
        code: 0,
        data: { main_orders: [{ main_order_id: 'A-order-1' }], has_more: false, total_count: 1 },
      }) as never;
    });

    await handleOrderSyncAlarm();
    for (let index = 0; index < 100 && !resolveLogistics; index += 1) await Promise.resolve();

    expect(harness.state?.orderProgress.domains.orders.syncRunStatus).toBe('done');
    expect(harness.state?.orderProgress.domains.logistics.syncRunStatus).toBe('running');
    expect(harness.state?.orderProgress.status).toBe('running');

    resolveLogistics(pageResult({ code: 0, data: { detail: true } }));
    for (let index = 0; index < 100 && harness.state?.orderProgress.domains.logistics.syncRunStatus !== 'done'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(harness.state?.orderProgress.domains.logistics.syncRunStatus).toBe('done');
    expect(harness.state?.orderProgress.status).toBe('ok');
  });
});
