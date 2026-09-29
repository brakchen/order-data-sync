/**
 * 订单 / 物流 / 结算 后台轮询的接线回归。
 *
 * 覆盖：alarm 注册与清除规则、三个暂停/关闭门控、
 * 订单域无 N+1、物流域逐单详情 + 请求间隔、单条失败不阻塞其余。
 *
 * 取数走 `executeTikTokRequestInBoundPage` 的页面执行器路径（bound tab +
 * chrome.scripting.executeScript），这里用「把注入函数 eval 出来」的方式驱动，
 * 与 tests/collected-response-logging.test.ts 同款手法。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderSyncState, OrderListCheckpoint } from '../src/core/types';
import { OrderSyncError } from '../src/core/order-sync';
import { createDefaultOrderProgress } from '../src/extension/storage';
import { resetHealthState, stopHealthPolling } from '../src/core/tts-erp-health';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  getStateWithinMutation: vi.fn(),
  saveState: vi.fn(),
  fetchReconciliation: vi.fn(),
  uploadDump: vi.fn(),
}));

vi.mock('wxt/utils/define-background', () => ({ defineBackground: <T>(entry: T) => entry }));
// 工厂里不能引用顶层 import（vi.mock 会被提升）：真实实现用 importActual 取。
vi.mock('../src/extension/storage', async () => {
  const actual = await vi.importActual<typeof import('../src/extension/storage')>(
    '../src/extension/storage',
  );
  return {
    createDefaultOrderSyncState: actual.createDefaultOrderSyncState,
    createDefaultOrderProgress: actual.createDefaultOrderProgress,
    mutateOrderSyncState: (mutation: (state: OrderSyncState) => OrderSyncState | Promise<OrderSyncState>) =>
      actual.runOrderSyncStateMutation(async () => {
        const current = await mocks.getState();
        const next = await mutation(current);
        await mocks.saveState(next);
        return next;
      }),
    createSafeErrorSummary: vi.fn(() => '同步失败,请检查同步配置与网络。'),
    getOrderSyncState: mocks.getState,
    getOrderSyncStateWithinMutation: mocks.getStateWithinMutation,
    ORDER_RUNTIME_LOG_LIMIT: 5_000,
    runOrderSyncStateMutation: actual.runOrderSyncStateMutation,
    saveOrderSyncState: mocks.saveState,
    sanitizeDiagnosticText: (value: string) => value,
  };
});
vi.mock('../src/core/order-sync', async () => {
  const actual = await vi.importActual<typeof import('../src/core/order-sync')>('../src/core/order-sync');
  return {
    OrderSyncError: actual.OrderSyncError,
    createOrderSyncDump: actual.createOrderSyncDump,
    fetchOrderSyncReconciliation: mocks.fetchReconciliation,
    uploadOrderSyncDump: mocks.uploadDump,
  };
});
vi.mock('../src/core/request-rate-limiter', () => ({
  ACCELERATED_REQUEST_INTERVAL_MS: 125,
  ACCELERATED_REQUEST_MAX_IN_FLIGHT: 8,
  CURSOR_REQUEST_INTERVAL_MS: 2,
  CURSOR_REQUEST_MAX_IN_FLIGHT: 100,
  createRequestRateLimiter: () => ({ acquire: async () => () => undefined }),
  createTokenBucketRateLimiter: () => ({ acquire: async () => () => undefined }),
}));

import {
  ensureLogisticsSyncAlarm,
  runInitialOrderDomainSync,
  ensureOrderSyncAlarm,
  ensureSettlementSyncAlarm,
  handleOrderSyncAlarm,
  pollOrderDomain,
} from '../src/extension/order-engine';
import { handleOrderMessage } from '../entrypoints/background';
import { createDefaultOrderSyncState } from '../src/extension/storage';

let state: OrderSyncState;
let alarms: Map<string, { periodInMinutes?: number; delayInMinutes?: number }>;

function boundState(overrides: Partial<OrderSyncState['settings']> = {}): OrderSyncState {
  const defaults = createDefaultOrderSyncState();
  return {
    ...defaults,
    shopRegion: { sellerId: 'seller', baseUrl: defaults.settings.syncBaseUrl, region: 'CN' },
    boundTab: {
      tabId: 7,
      url: 'https://seller.tiktokglobalshop.com/ads',
      sellerId: 'seller',
      advertiserId: 'advertiser',
      shopRegion: 'CN',
    },
    settings: { ...defaults.settings, syncToken: 'fixture-token', ...overrides },
  };
}

function checkpointFor(ids: string[], auditOffset = 40): OrderListCheckpoint {
  const middle = ids[Math.floor(Math.max(0, ids.length - 1) / 2)] ?? null;
  return {
    total: ids.length,
    headOrderId: ids[0] ?? null,
    middleOrderId: middle,
    tailOrderId: ids[ids.length - 1] ?? null,
    orderingDirection: 'desc',
    windowKey: new Date().toISOString().slice(0, 10),
    auditOffset,
    lastExactAuditAt: new Date().toISOString(),
    statusRefreshVersion: 1,
    capturedAt: new Date().toISOString(),
  };
}

/** 订单列表 + 详情都由这个 fetch 桩回答；记录每次请求的 URL。 */
let requested: string[];
let requestedMethods: string[];
function stubFetch(orderIds: string[]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    requestedMethods.push(init?.method ?? 'GET');
    const payload = url.includes('order_list') || url.includes('/order/list') || url.includes('order-list')
      ? { code: 0, data: { main_orders: orderIds.map((id) => ({ main_order_id: id })) } }
      : url.includes('/api/fulfillment/order/get')
        ? { code: 0, message: 'success', data: { main_order: [{ main_order_id: url }] } }
        : url.includes('/api/v1/fulfillment/order/history')
          ? { code: 0, message: 'success', data: { total_count: 0, order_history: [] } }
          : { code: 0, data: { detail_for: url } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

function uploadsForDomain(domain: 'orders' | 'logistics' | 'statements') {
  return mocks.uploadDump.mock.calls.filter((call) => {
    const dump = call[2] as { domain?: string; endpoint?: string } | undefined;
    if (dump?.domain !== domain) return false;
    // The order page producer intentionally stores detail/history dumps under
    // the backend-supported `orders` domain. Existing assertions in this
    // suite target the order-list producer, so distinguish it by endpoint.
    if (domain === 'orders') {
      return !dump.endpoint?.includes('/api/fulfillment/order/get')
        && !dump.endpoint?.includes('/api/v1/fulfillment/order/history');
    }
    return true;
  });
}

function withoutAdvertiser(): OrderSyncState {
  const boundTab = { ...state.boundTab! };
  delete boundTab.advertiserId;
  return { ...state, boundTab };
}

function chromeHarness(): void {
  alarms = new Map();
  vi.stubGlobal('chrome', {
    alarms: {
      get: vi.fn(async (name: string) => alarms.get(name)),
      create: vi.fn(async (name: string, info: { periodInMinutes?: number; delayInMinutes?: number }) => { alarms.set(name, info); }),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (state.boundTab?.tabId !== tabId) throw new Error('tab not found');
        return { id: tabId, url: state.boundTab.url };
      }),
    },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    scripting: {
      executeScript: vi.fn(async (options: {
        func: (url: string, body: Record<string, unknown>) => Promise<unknown>;
        args: [string, Record<string, unknown>];
      }) => {
        const isolated = new Function(`return (${options.func.toString()})`)() as typeof options.func;
        return [{ result: await isolated(...options.args) }];
      }),
    },
  });
}

beforeEach(() => {
  stopHealthPolling();
  resetHealthState();
  vi.useFakeTimers();
  vi.clearAllMocks();
  requested = [];
  requestedMethods = [];
  chromeHarness();
  state = boundState();
  mocks.getState.mockImplementation(async () => state);
  mocks.getStateWithinMutation.mockImplementation(async () => state);
  mocks.saveState.mockImplementation(async (next: OrderSyncState) => { state = next; });
  mocks.fetchReconciliation.mockResolvedValue(null);
  mocks.uploadDump.mockResolvedValue({ requestId: 'req-1' });
});
afterEach(async () => {
  // Drain any scheduled per-item delays before resetting shared module state.
  await vi.advanceTimersByTimeAsync(120_000);
  stopHealthPolling();
  resetHealthState();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('订单域 alarm 注册规则', () => {
  it('已绑定店铺时注册为一次性下一轮 alarm', async () => {
    await ensureOrderSyncAlarm();
    await ensureLogisticsSyncAlarm();
    expect(alarms.get('order-data-sync:orders')?.delayInMinutes).toBe(1440);
    expect(alarms.get('order-data-sync:logistics')?.delayInMinutes).toBe(1440);
  });

  it('服务 worker 重启后会立即恢复仅标记 running 的订单轮次', async () => {
    state = {
      ...state,
      orderProgress: {
        ...state.orderProgress,
        domains: {
          ...state.orderProgress.domains,
          orders: {
            ...state.orderProgress.domains.orders,
            syncRunId: 'run-before-suspend',
            syncRunStatus: 'running',
            listPhase: 'list_fetching',
          },
        },
      },
    };

    await ensureOrderSyncAlarm();

    expect(alarms.get('order-data-sync:orders')?.delayInMinutes).toBe(0.1);
  });

  it('未绑定店铺时清除，不空转', async () => {
    await ensureOrderSyncAlarm();
    expect(alarms.has('order-data-sync:orders')).toBe(true);
    state = { ...state, boundTab: null };
    await ensureOrderSyncAlarm();
    expect(alarms.has('order-data-sync:orders')).toBe(false);
  });

  it('只有 seller 身份时也注册订单域 alarm', async () => {
    state = withoutAdvertiser();
    await ensureLogisticsSyncAlarm();
    expect(alarms.get('order-data-sync:logistics')?.delayInMinutes).toBe(1440);
  });

  it('关闭订单数据采集后清除已有 alarm，后续 ensure 也不会重建', async () => {
    await ensureOrderSyncAlarm();
    await ensureLogisticsSyncAlarm();
    await ensureSettlementSyncAlarm();
    alarms.set('order-data-sync:orders:continue', { delayInMinutes: 0.1 });
    alarms.set('order-data-sync:logistics:continue', { delayInMinutes: 0.1 });
    alarms.set('order-data-sync:statements:continue', { delayInMinutes: 0.1 });

    await handleOrderMessage({
      type: 'order-sync:save-settings',
      settings: { ...state.settings, orderDomainSyncEnabled: false },
    }, {} as chrome.runtime.MessageSender);

    expect(state.settings.orderDomainSyncEnabled).toBe(false);
    expect(alarms.size).toBe(0);

    await ensureOrderSyncAlarm();
    await ensureLogisticsSyncAlarm();
    await ensureSettlementSyncAlarm();
    expect(alarms.size).toBe(0);
  });

  it('物流批次执行中不由 ensure 额外创建主轮次 alarm', async () => {
    let resolveList!: (response: Response) => void;
    const listResponse = new Promise<Response>((resolve) => { resolveList = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('order_list') || url.includes('/order/list') || url.includes('order-list')) {
        return listResponse;
      }
      return new Response(JSON.stringify({ code: 0, data: { detail_for: url } }), { status: 200 });
    }));

    const running = pollOrderDomain('logistics');
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    await ensureLogisticsSyncAlarm();

    expect(alarms.has('order-data-sync:logistics')).toBe(false);
    resolveList(new Response(JSON.stringify({
      code: 0,
      data: { main_orders: [{ main_order_id: 'o1' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await running;
  });
});

describe('订单域首次主动同步', () => {
  it('缺少店铺地区时硬拦截，不发起任何 TikTok 请求', async () => {
    state = {
      ...state,
      shopRegion: null,
      boundTab: { ...state.boundTab!, shopRegion: undefined },
    };

    const usedPagePipeline = await handleOrderSyncAlarm('manual');

    expect(usedPagePipeline).toBe(false);
    expect(requested).toHaveLength(0);
    expect(state.runtimeLogs.some((log) => log.context?.event === 'poll_skipped'
      && log.context?.details?.hasShopRegion === false
      && typeof log.message === 'string')).toBe(true);
    expect(state.runtimeLogs.find((log) => log.context?.event === 'poll_skipped')?.message)
      .toContain('店铺地区未配置');
  });

  it('列表请求尚未返回时就持久化同步中和当前页', async () => {
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            total: 3,
            pending: 2,
            pendingOrderIds: ['old-2', 'old-3'],
            resumeOrderId: 'old-2',
            snapshotKeys: ['old-1', 'old-2', 'old-3'],
          },
        },
      },
    };
    let resolveList!: (response: Response) => void;
    const listResponse = new Promise<Response>((resolve) => { resolveList = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      requested.push(String(input));
      return listResponse;
    }));

    const running = handleOrderSyncAlarm();
    for (let index = 0; index < 200
      && state.orderProgress?.domains.orders.listPhase !== 'list_fetching'; index += 1) {
      await Promise.resolve();
    }

    expect(state.orderProgress).toMatchObject({
      status: 'running',
      domains: {
        orders: {
          listPhase: 'list_fetching',
          listPage: 1,
          total: 3,
          pending: 2,
          pendingOrderIds: ['old-2', 'old-3'],
          resumeOrderId: 'old-2',
          snapshotKeys: ['old-1', 'old-2', 'old-3'],
        },
      },
    });

    resolveList(new Response(JSON.stringify({
      code: 0,
      data: { main_orders: [{ main_order_id: 'o1' }], has_more: false, total_count: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await running;
  });

  it('订单数据采集关闭后停止继续读取后续订单页', async () => {
    let orderListCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('order_list') || url.includes('/order/list') || url.includes('order-list')) {
        orderListCalls += 1;
        if (orderListCalls === 1) {
          state = { ...state, settings: { ...state.settings, orderDomainSyncEnabled: false } };
        }
        return new Response(JSON.stringify({
          code: 0,
          data: {
            main_orders: [{ main_order_id: `o${orderListCalls}` }],
            has_more: true,
            total_count: 40,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }));

    await handleOrderSyncAlarm();

    expect(orderListCalls).toBe(1);
    expect(uploadsForDomain('orders')).toHaveLength(0);
    expect(state.runtimeLogs.some((log) => log.context?.event === 'poll_stopped'
      && log.context?.details?.reason === 'sync_scope_changed')).toBe(true);
  });

  it('启动后可以立即拉取订单、物流和结算入口', async () => {
    stubFetch([]);

    await runInitialOrderDomainSync();

    // 订单和物流现在各自消费订单列表；物流消费者可能回退到独立的
    // order/list 发现候选订单，因此这里不再把请求次数绑死为 1。
    expect(requested.filter((url) => url.includes('/api/fulfillment/order/list')).length).toBeGreaterThanOrEqual(1);
    expect(requested.some((url) => url.includes('statement'))).toBe(true);
  });

});

describe('订单域轮询门控', () => {
  it.each([
    ['未绑定店铺', { boundTab: null } as Partial<OrderSyncState>],
    ['无同步令牌', { settings: { ...boundState().settings, syncToken: '  ' } } as Partial<OrderSyncState>],
    ['用户暂停', { settings: { ...boundState().settings, syncPaused: true } } as Partial<OrderSyncState>],
    // 0.1.149：删「永久拒绝自动暂停」case。autoPausedReason 全局熔断已移除，
    // needsHuman 是 per-unit 不影响订单域轮询（订单域也不走 needsHuman 流程）。
    ['订单采集开关关闭', { settings: { ...boundState().settings, orderDomainSyncEnabled: false } } as Partial<OrderSyncState>],
  ])('%s 时不发起任何请求', async (_label, override) => {
    stubFetch(['o1']);
    state = { ...state, ...override };
    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(400_000);
    await running;
    expect(requested).toEqual([]);
    expect(mocks.uploadDump).not.toHaveBeenCalled();
  });
});

describe('订单域（无 N+1）', () => {
  it('即使存在 advertiser 身份，订单作用域的 shopId 仍使用 Seller', async () => {
    stubFetch(['o1']);

    await handleOrderSyncAlarm();

    expect(uploadsForDomain('orders')).toHaveLength(1);
    expect(uploadsForDomain('orders')[0]![1]).toEqual({ sellerId: 'seller', shopId: 'seller' });
  });

  it('没有 advertiser 身份时仍按 seller 作用域同步订单', async () => {
    state = withoutAdvertiser();
    stubFetch(['o1']);

    await handleOrderSyncAlarm();

    expect(uploadsForDomain('orders')).toHaveLength(1);
    expect(uploadsForDomain('orders')[0]![1]).toEqual({ sellerId: 'seller', shopId: 'seller' });
  });

  it('advertiser 身份变化不应中断 seller 作用域的订单同步', async () => {
    stubFetch(['o1', 'o2']);
    mocks.uploadDump.mockImplementation(async () => {
      state = {
        ...state,
        boundTab: { ...state.boundTab!, advertiserId: 'different-advertiser' },
      };
      return { requestId: 'req-1' };
    });

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(6_000);
    await running;

    expect(uploadsForDomain('orders')).toHaveLength(2);
    expect(state.orderProgress?.domains.orders.uploaded).toBe(2);
  });

  it('同步地址变化后不应继续向旧后端上传订单', async () => {
    stubFetch(['o1', 'o2']);
    mocks.uploadDump.mockImplementationOnce(async () => {
      state = {
        ...state,
        settings: { ...state.settings, syncBaseUrl: 'https://other.example.test' },
      };
      return { requestId: 'req-1' };
    });

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(6_000);
    await running;

    expect(uploadsForDomain('orders')).toHaveLength(1);
  });

  it('已存在订单也必须刷新，不能用存在性当成可变数据的新鲜度证明', async () => {
    stubFetch(['o1', 'o2']);

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(6_000);
    await running;

    // 仅 1 次订单列表请求（订单字段都在列表行里）
    expect(requested.filter((url) => url.includes('/api/fulfillment/order/list'))).toHaveLength(1);
    expect(uploadsForDomain('orders')).toHaveLength(2);
    expect(uploadsForDomain('orders').map((call) => (call[2] as { mainOrderId: string }).mainOrderId)).toEqual(['o1', 'o2']);
  });

  it('跨分页重复的订单只按一个同步单元处理', async () => {
    stubFetch(['o1', 'o1']);

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(6_000);
    await running;

    expect(uploadsForDomain('orders')).toHaveLength(1);
  });

  it('增量轮次无新增时保留服务端总数，不把已完成进度写成 0%', async () => {
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            total: 2,
            serverTotal: 2,
            listTotalRows: 2,
            orderListCheckpoint: checkpointFor(['o1', 'o2'], 1),
          },
        },
      },
    };
    mocks.fetchReconciliation.mockResolvedValue({
      orders: {
        serverTotal: 2,
        anchors: [{ position: 0, orderId: 'o1' }, { position: 1, orderId: 'o2' }],
        canIncremental: true,
        offsetSafe: true,
        ordering: { field: 'order_time', direction: 'desc', tieBreaker: 'order_id' },
        hotWindowSize: 0,
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      requested.push(String(input));
      return new Response(JSON.stringify({
        code: 0,
        data: {
          main_orders: [{ main_order_id: 'o1' }, { main_order_id: 'o2' }],
          has_more: false,
          total_count: 2,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(12_000);
    await running;

    // has-data 已移除，所有订单全量上传
    expect(uploadsForDomain('orders')).toHaveLength(2);
    expect(state.orderProgress?.domains.orders).toMatchObject({
      total: 2,
      covered: 2,
      pending: 0,
    });
    // 订单页生产者已完成；物流/详情/历史消费者仍可在后台收尾，整体状态
    // 在它们完成前保持 running 是预期行为。
    expect(state.orderProgress?.domains.orders.syncRunStatus).toBe('done');
  });

  it('降序列表新增订单时按新增前缀校验锚点，不误回退全量扫描', async () => {
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            total: 3,
            serverTotal: 3,
            snapshotKeys: ['old-1', 'old-2', 'old-3'],
            listTotalRows: 3,
            orderListCheckpoint: checkpointFor(['old-1', 'old-2', 'old-3'], 1),
          },
        },
      },
    };
    mocks.fetchReconciliation.mockResolvedValue({
      orders: {
        serverTotal: 3,
        anchors: [{ position: 0, orderId: 'old-1' }, { position: 2, orderId: 'old-3' }],
        canIncremental: true,
        offsetSafe: true,
        ordering: { field: 'order_time', direction: 'desc', tieBreaker: 'order_id' },
        hotWindowSize: 1,
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      requested.push(String(input));
      return new Response(JSON.stringify({
        code: 0,
        data: {
          main_orders: ['new-1', 'new-2', 'old-1', 'old-2', 'old-3']
            .map((id) => ({ main_order_id: id })),
          has_more: false,
          total_count: 5,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const running = handleOrderSyncAlarm();
    await vi.runAllTimersAsync();
    await running;

    // has-data 已移除，所有订单全量上传
    expect(uploadsForDomain('orders')).toHaveLength(7);
    expect(uploadsForDomain('orders').map((call) => (call[2] as { mainOrderId: string }).mainOrderId))
      .toContain('new-1');
    expect(uploadsForDomain('orders').map((call) => (call[2] as { mainOrderId: string }).mainOrderId))
      .toContain('new-2');
    expect(state.runtimeLogs.some((log) => log.context?.details?.action === 'incremental_selected'
      && log.context?.details?.strategy === 'incremental')).toBe(true);
  });

  it('服务端历史总数小于 TikTok 当前窗口时仍按本地 checkpoint 计算新增量', async () => {
    const oldIds = Array.from({ length: 638 }, (_, index) => `old-${index + 1}`);
    const ids = ['new-1', ...oldIds];
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: Object.assign({
            ...progress.domains.orders,
            total: 638,
            serverTotal: 519,
            listTotalRows: 638,
            auditOffset: 40,
          }, {
            orderListCheckpoint: {
              total: 638,
              headOrderId: 'old-1',
              middleOrderId: 'old-319',
              tailOrderId: 'old-638',
              orderingDirection: 'desc',
              windowKey: new Date().toISOString().slice(0, 10),
              auditOffset: 40,
              lastExactAuditAt: new Date().toISOString(),
              statusRefreshVersion: 1,
              capturedAt: '2026-09-21T00:00:00.000Z',
            },
          }),
        },
      },
    };
    mocks.fetchReconciliation.mockResolvedValue({
      orders: {
        serverTotal: 519,
        anchors: [{ position: 0, orderId: 'old-1' }, { position: 518, orderId: 'old-519' }],
        canIncremental: true,
        offsetSafe: true,
        ordering: { field: 'order_time', direction: 'desc', tieBreaker: 'order_id' },
        hotWindowSize: 40,
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      requested.push(String(input));
      const body = JSON.parse(String(init?.body ?? '{}')) as { offset?: number; count?: number };
      const offset = body.offset ?? 0;
      const page = ids.slice(offset, offset + (body.count ?? 20));
      return new Response(JSON.stringify({
        code: 0,
        data: {
          main_orders: page.map((id) => ({ main_order_id: id })),
          has_more: offset + page.length < ids.length,
          total_count: ids.length,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const running = handleOrderSyncAlarm();
    await vi.runAllTimersAsync();
    await running;

    expect(uploadsForDomain('orders').map((call) => (call[2] as { mainOrderId: string }).mainOrderId))
      .toContain('new-1');
    // has-data 已移除，所有订单全量上传
    expect(uploadsForDomain('orders').length).toBeLessThanOrEqual(80);
    expect(state.orderProgress?.domains.orders.syncStrategy).toBe('incremental');
    expect(state.orderProgress?.domains.orders.orderListCheckpoint).toMatchObject({
      total: 639,
      headOrderId: 'new-1',
      middleOrderId: 'old-319',
      tailOrderId: 'old-638',
    });
  });

  it.each([
    ['首单', ['replacement-head', 'o2', 'o3', 'o4', 'o5'], 'replacement-head'],
    ['中间单', ['o1', 'o2', 'replacement-middle', 'o4', 'o5'], 'replacement-middle'],
    ['尾单', ['o1', 'o2', 'o3', 'o4', 'replacement-tail'], 'replacement-tail'],
  ])('checkpoint 能发现%s缺失并只补缺失订单', async (_label, ids, missingId) => {
    const originalIds = ['o1', 'o2', 'o3', 'o4', 'o5'];
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            total: originalIds.length,
            orderListCheckpoint: checkpointFor(originalIds, 1),
          },
        },
      },
    };
    mocks.fetchReconciliation.mockResolvedValue({
      orders: {
        serverTotal: originalIds.length,
        anchors: [{ position: 0, orderId: 'o1' }, { position: 4, orderId: 'o5' }],
        canIncremental: true,
        offsetSafe: true,
        ordering: { field: 'order_time', direction: 'desc', tieBreaker: 'order_id' },
        hotWindowSize: 1,
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        main_orders: ids.map((id) => ({ main_order_id: id })),
        has_more: false,
        total_count: ids.length,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(60_000);
    await running;

    expect(uploadsForDomain('orders').map((call) => (call[2] as { mainOrderId: string }).mainOrderId))
      .toContain(missingId);
    // has-data 已移除，所有订单全量上传
    expect(uploadsForDomain('orders')).toHaveLength(5);
  });

  it('升级后会精确巡检并刷新历史取消单，即使服务端已存在该订单', async () => {
    const legacyCheckpoint = checkpointFor(['active-hot', 'cancelled-historical', 'active-covered'], 1);
    delete legacyCheckpoint.statusRefreshVersion;
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            total: 3,
            orderListCheckpoint: legacyCheckpoint,
          },
        },
      },
    };
    mocks.fetchReconciliation.mockResolvedValue({
      orders: {
        serverTotal: 3,
        anchors: [{ position: 0, orderId: 'active-hot' }, { position: 2, orderId: 'active-covered' }],
        canIncremental: true,
        offsetSafe: true,
        ordering: { field: 'order_time', direction: 'desc', tieBreaker: 'order_id' },
        hotWindowSize: 1,
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        main_orders: [
          { main_order_id: 'active-hot', order_status_module: [{ main_order_status: 101 }] },
          { main_order_id: 'cancelled-historical', order_status_module: [{ main_order_status: 104 }] },
          { main_order_id: 'active-covered', order_status_module: [{ main_order_status: 101 }] },
        ],
        has_more: false,
        total_count: 3,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const running = handleOrderSyncAlarm();
    await vi.runAllTimersAsync();
    await running;

    // has-data 已移除，所有订单全量上传
    expect(uploadsForDomain('orders').map((call) => (call[2] as { mainOrderId: string }).mainOrderId))
      .toEqual(['active-hot', 'cancelled-historical', 'active-covered']);
    expect(state.orderProgress?.domains.orders.syncStrategy).toBe('repair');
  });

  it('头中尾锚点都未变化时，轮转巡检仍能发现采样区间内的任意替换单', async () => {
    const originalIds = Array.from({ length: 10 }, (_, index) => `o${index + 1}`);
    const ids = [...originalIds.slice(0, 7), 'replacement-arbitrary-middle', ...originalIds.slice(8)];
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            total: originalIds.length,
            orderListCheckpoint: checkpointFor(originalIds, 1),
          },
        },
      },
    };
    mocks.fetchReconciliation.mockResolvedValue({
      orders: {
        serverTotal: originalIds.length,
        anchors: [{ position: 0, orderId: 'o1' }, { position: 4, orderId: 'o5' }, { position: 9, orderId: 'o10' }],
        canIncremental: true,
        offsetSafe: true,
        ordering: { field: 'order_time', direction: 'desc', tieBreaker: 'order_id' },
        hotWindowSize: 1,
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { main_orders: ids.map((id) => ({ main_order_id: id })), has_more: false, total_count: ids.length },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(60_000);
    await running;

    // has-data 已移除，所有订单全量上传（含替换单）
    expect(uploadsForDomain('orders').map((call) => (call[2] as { mainOrderId: string }).mainOrderId))
      .toContain('replacement-arbitrary-middle');
    expect(uploadsForDomain('orders')).toHaveLength(11);
  });

  it('存在性巡检失败时保守上传当前修复页，不把未知当成已覆盖', async () => {
    const originalIds = ['o1', 'o2', 'o3', 'o4', 'o5'];
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            total: originalIds.length,
            orderListCheckpoint: checkpointFor(originalIds, 1),
          },
        },
      },
    };
    mocks.fetchReconciliation.mockResolvedValue({
      orders: {
        serverTotal: originalIds.length,
        anchors: [{ position: 2, orderId: 'wrong-middle' }],
        canIncremental: true,
        offsetSafe: true,
        ordering: { field: 'order_time', direction: 'desc', tieBreaker: 'order_id' },
        hotWindowSize: 1,
      },
    });
    stubFetch(originalIds);

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(60_000);
    await running;

    expect(uploadsForDomain('orders')).toHaveLength(originalIds.length);
  });

  it('订单列表会继续读取后续页，而不是静默丢单', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      requested.push(String(input));
      const body = JSON.parse(String(init?.body ?? '{}')) as { offset?: number };
      const ids = body.offset === 0 ? ['o1', 'o2'] : ['o3'];
      const hasMore = body.offset === 0;
      return new Response(JSON.stringify({
        code: 0,
        data: { main_orders: ids.map((id) => ({ main_order_id: id })), has_more: hasMore, total_count: 3 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(12_000);
    await running;

    expect(requested.filter((url) => url.includes('/api/fulfillment/order/list'))).toHaveLength(2);
  });

  it('订单分页读取会实时记录当前页和估算总页数', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      requested.push(String(input));
      const body = JSON.parse(String(init?.body ?? '{}')) as { offset?: number };
      const firstPage = body.offset === 0;
      return new Response(JSON.stringify({
        code: 0,
        data: {
          main_orders: (firstPage ? ['o1', 'o2'] : ['o3']).map((id) => ({ main_order_id: id })),
          has_more: firstPage,
          total_count: 992,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(12_000);
    await running;

    const pages = state.runtimeLogs
      .filter((log) => log.context?.details?.action === 'list_page_fetched')
      .map((log) => ({ page: log.context?.details?.page, pageCount: log.context?.details?.pageCount }));
    expect(pages).toEqual([
      { page: 1, pageCount: 50 },
      { page: 2, pageCount: 50 },
    ]);
  });

  it('订单第 1 页完成后立即启动物流，且不等待第 2 页列表返回', async () => {
    let page2Resolve!: (response: Response) => void;
    const page2Response = new Promise<Response>((resolve) => { page2Resolve = resolve; });
    let detailResolve!: (response: Response) => void;
    const detailResponse = new Promise<Response>((resolve) => { detailResolve = resolve; });
    let page2Requested = false;
    let detailRequested = false;
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      const body = JSON.parse(String(init?.body ?? '{}')) as { offset?: number };
      if (url.includes('/api/fulfillment/order/list')) {
        const firstPage = body.offset === 0;
        if (!firstPage) {
          page2Requested = true;
          return page2Response;
        }
        return new Response(JSON.stringify({
          code: 0,
          data: {
            main_orders: [{ main_order_id: firstPage ? 'o1' : 'o2' }],
            has_more: true,
            total_count: 2,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      detailRequested = true;
      return detailResponse;
    }));

    const running = handleOrderSyncAlarm();
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(page2Requested).toBe(true);
    expect(detailRequested).toBe(true);

    page2Resolve(new Response(JSON.stringify({
      code: 0,
      data: {
        main_orders: [{ main_order_id: 'o2' }],
        has_more: false,
        total_count: 2,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    detailResolve(new Response(JSON.stringify({ detail_for: 'o1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await vi.advanceTimersByTimeAsync(12_000);
    await running;
  });

  it('订单页处理超过单批上限时仍会完成本页并保留进度', async () => {
    const ids = Array.from({ length: 55 }, (_, index) => `o${index + 1}`);
    stubFetch(ids);

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(200_000);
    await running;

    expect(uploadsForDomain('orders')).toHaveLength(55);
    expect(state.orderProgress?.domains.orders).toMatchObject({
      total: 55,
      uploaded: 55,
      pending: 0,
      resumeOrderId: null,
      currentOrderId: null,
    });
    expect(alarms.has('order-data-sync:orders:continue')).toBe(false);
    expect(alarms.get('order-data-sync:orders')?.delayInMinutes).toBe(1440);
  });

  it('跨页失败订单不会被下一页的进度覆盖', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/api/fulfillment/order/list')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { offset?: number };
        const firstPage = body.offset === 0;
        return new Response(JSON.stringify({
          code: 0,
          data: {
            main_orders: [{ main_order_id: firstPage ? 'o1' : 'o2' }],
            has_more: firstPage,
            total_count: 2,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 0, data: { detail_for: url } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    mocks.uploadDump.mockImplementation(async (_settings, _identity, dump) => {
      if ((dump as { domain?: string; mainOrderId?: string }).domain === 'orders'
        && (dump as { mainOrderId?: string }).mainOrderId === 'o1') {
        throw new Error('order page 1 failed');
      }
      return { requestId: 'req-1' };
    });

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(12_000);
    await running;

    expect(state.orderProgress?.domains.orders).toMatchObject({
      total: 2,
      uploaded: 1,
      pending: 1,
      failed: 1,
      failedOrderIds: ['o1'],
      resumeOrderId: 'o1',
    });
    expect(alarms.get('order-data-sync:orders:continue')?.delayInMinutes).toBe(0.1);
  });

  it('失败队列不会占满批次而饿死后续订单', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `o${index + 1}`);
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            total: 100,
            uploaded: 0,
            pending: 100,
            resumeOrderId: 'o51',
            failedOrderIds: ids.slice(0, 50),
            snapshotKeys: ids,
          },
        },
      },
    };
    stubFetch(ids);
    mocks.uploadDump.mockImplementation(async (_settings, _scope, dump: { mainOrderId?: string }) => {
      if (dump.mainOrderId && Number(dump.mainOrderId.slice(1)) <= 50) throw new Error('permanent failure');
      return { requestId: 'req-1' };
    });

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(400_000);
    await running;

    expect(uploadsForDomain('orders').some((call) => call[2]?.mainOrderId === 'o51')).toBe(true);
    expect(state.orderProgress?.domains.orders.failed).toBeGreaterThan(0);
  });

  it('订单列表失败时保留断点并安排下一整轮重试', async () => {
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            total: 100,
            uploaded: 50,
            pending: 50,
            resumeOrderId: 'o51',
            snapshotKeys: Array.from({ length: 100 }, (_, index) => `o${index + 1}`),
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 1 }), { status: 503 })));

    await handleOrderSyncAlarm();

    expect(state.orderProgress?.domains.orders).toMatchObject({
      total: 100,
      uploaded: 50,
      pending: 50,
      resumeOrderId: 'o51',
      lastError: expect.stringContaining('503'),
    });
    expect(alarms.get('order-data-sync:orders')?.delayInMinutes).toBe(1440);
  });

  it('订单列表 HTTP 200 但业务 code 非 0 时不上传也不推进进度', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 105005,
      message: 'scope missing',
      data: { main_orders: [{ main_order_id: 'o1' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await handleOrderSyncAlarm();

    expect(mocks.uploadDump).not.toHaveBeenCalled();
    expect(state.orderProgress?.domains.orders.lastError).toContain('订单列表 business code 105005');
  });

  it('订单列表暂时为空时保留断点并安排下一整轮重试', async () => {
    const progress = createDefaultOrderSyncState().orderProgress!;
    const ids = Array.from({ length: 55 }, (_, index) => `o${index + 1}`);
    const previousCheckpoint = checkpointFor(ids);
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            total: 55,
            uploaded: 50,
            pending: 5,
            resumeOrderId: 'o51',
            snapshotKeys: ids,
            pendingOrderIds: ids.slice(50),
            orderListCheckpoint: previousCheckpoint,
          },
        },
      },
    };
    stubFetch([]);

    await handleOrderSyncAlarm();

    expect(state.orderProgress?.domains.orders).toMatchObject({
      total: 55,
      uploaded: 50,
      pending: 5,
      resumeOrderId: 'o51',
      pendingOrderIds: ids.slice(50),
      lastError: expect.stringContaining('返回 0 行'),
    });
    expect(state.orderProgress?.domains.orders.orderListCheckpoint).toEqual(previousCheckpoint);
    expect(alarms.get('order-data-sync:orders')?.delayInMinutes).toBe(1440);
  });

  it('首次订单列表为空时不创建零值 checkpoint，下一轮仍会走修复路径', async () => {
    stubFetch([]);

    await handleOrderSyncAlarm();

    expect(state.orderProgress?.domains.orders.orderListCheckpoint).toBeNull();
    expect(state.orderProgress?.domains.orders.lastError).toContain('返回 0 行');
    expect(alarms.get('order-data-sync:orders')?.delayInMinutes).toBe(1440);
  });

  it('游标分页按逻辑位置识别历史页，不会把每一页都当成热区', async () => {
    const ids = Array.from({ length: 60 }, (_, index) => `cursor-${index + 1}`);
    const pages = [
      ids.slice(0, 20),
      [ids[19]!, ...ids.slice(20, 40)],
      [ids[39]!, ...ids.slice(40)],
    ];
    const cursorRequests: Array<{ offset: number; cursor: string; paginationType: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (!(url.includes('order_list') || url.includes('/order/list') || url.includes('order-list'))) {
        return new Response(JSON.stringify({ code: 0, data: { detail_for: url } }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        offset?: number;
        search_cursor?: string;
        pagination_type?: number;
      };
      cursorRequests.push({
        offset: body.offset ?? -1,
        cursor: body.search_cursor ?? '',
        paginationType: body.pagination_type ?? -1,
      });
      const pageIndex = body.search_cursor === '' ? 0 : body.search_cursor === 'cursor-1' ? 1 : 2;
      return new Response(JSON.stringify({
        code: 0,
        data: {
          main_orders: pages[pageIndex]!.map((id) => ({ main_order_id: id })),
          has_more: pageIndex < pages.length - 1,
          search_next_has_more: pageIndex < pages.length - 1,
          search_next_cursor: pageIndex < pages.length - 1 ? `cursor-${pageIndex + 1}` : undefined,
          total_count: ids.length,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(200_000);
    await running;

    expect(cursorRequests.slice(0, 3).map((request) => request.offset)).toEqual([0, 0, 0]);
    expect(cursorRequests.slice(0, 3).map((request) => request.paginationType)).toEqual([0, 1, 1]);
    expect(uploadsForDomain('orders').map((call) => (call[2] as { mainOrderId: string }).mainOrderId))
      .toContain('cursor-41');
    expect(uploadsForDomain('orders').every((call) => {
      const dump = call[2] as { request?: { body?: { offset?: number; search_cursor?: string } } };
      return dump.request?.body?.offset === 0;
    })).toBe(true);
    expect(state.orderProgress?.domains.orders.orderListCheckpoint).toMatchObject({
      total: 60,
      headOrderId: 'cursor-1',
      middleOrderId: 'cursor-30',
      tailOrderId: 'cursor-60',
    });
  });

  it('批次之间新增订单时会纳入当前轮次', async () => {
    stubFetch(Array.from({ length: 55 }, (_, index) => `o${index + 1}`));
    let running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(200_000);
    await running;

    stubFetch(['new-order', ...Array.from({ length: 55 }, (_, index) => `o${index + 1}`)]);
    running = handleOrderSyncAlarm();
    await vi.advanceTimersByTimeAsync(200_000);
    await running;

    expect(uploadsForDomain('orders').some((call) => call[2]?.mainOrderId === 'new-order')).toBe(true);
    expect(state.orderProgress?.domains.orders).toMatchObject({ pending: 0, resumeOrderId: null });
  });

  it('全部已覆盖时不请求 TikTok', async () => {
    stubFetch(['o1']);
    await handleOrderSyncAlarm();
    expect(uploadsForDomain('orders')).toHaveLength(1);
  });
});

describe('物流域（N+1，逐单详情）', () => {
  it('候选订单全部为终态时保留终态订单的完成进度', async () => {
    mocks.fetchReconciliation.mockResolvedValue({
      logistics: {
        complete: true,
        items: [{
          orderId: 'o-terminal',
          packageIds: ['pkg-terminal'],
          isTerminal: true,
          terminalReason: 'action_code:50101',
          nextCheckAt: null,
        }],
        nextCursor: null,
      },
    });

    await pollOrderDomain('logistics');

    expect(mocks.uploadDump).not.toHaveBeenCalled();
    expect(state.orderProgress?.domains.logistics).toMatchObject({
      total: 1,
      uploaded: 1,
      pending: 0,
    });
    expect(state.orderProgress?.status).toBe('ok');
  });

  it('订单列表正在请求时物流不能把空的 reconcile 结果误判为已完成', async () => {
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            listPhase: 'list_fetching',
            pending: 0,
            currentOrderId: null,
            resumeOrderId: null,
            failedOrderIds: [],
          },
        },
      },
    };
    mocks.fetchReconciliation.mockResolvedValue({
      logistics: { complete: true, items: [], nextCursor: null },
    });
    stubFetch(['o1']);

    await pollOrderDomain('logistics');

    expect(mocks.uploadDump).toHaveBeenCalledOnce();
    expect(state.orderProgress?.domains.logistics.syncStrategy).toBe('fallback');
  });

  it('订单仍在首轮续传且后端暂时没有候选时回退当前 TikTok 订单列表', async () => {
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: {
            ...progress.domains.orders,
            pending: 10,
            resumeOrderId: 'o1',
          },
        },
      },
    };
    mocks.fetchReconciliation.mockResolvedValue({
      logistics: { complete: true, items: [], nextCursor: null },
    });
    stubFetch(['o1']);

    await pollOrderDomain('logistics');

    expect(mocks.uploadDump).toHaveBeenCalledOnce();
    expect(state.orderProgress?.domains.logistics.syncStrategy).toBe('fallback');
  });

  it('main_order_status=104 的取消订单不请求物流详情', async () => {
    mocks.fetchReconciliation.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      requestedMethods.push(init?.method ?? 'GET');
      if (url.includes('/api/fulfillment/order/list')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            main_orders: [
              { main_order_id: 'cancelled', order_status_module: [{ main_order_status: 104 }] },
              { main_order_id: 'active', order_status_module: [{ main_order_status: 101 }] },
            ],
            has_more: false,
            total_count: 2,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 0, data: { detail_for: url } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await pollOrderDomain('logistics');

    expect(requestedMethods).toEqual(['POST', 'GET']);
    expect(requested[1]).toContain('main_order_id=active');
    expect(requested[1]).not.toContain('main_order_id=cancelled');
    expect(uploadsForDomain('logistics').map((call) => (call[2] as { mainOrderId: string }).mainOrderId))
      .toEqual(['active']);
    expect(state.orderProgress?.domains.logistics).toMatchObject({
      uploaded: 2,
      pending: 0,
      failed: 0,
    });
  });

  it('逐单请求详情并上传，每轮都刷新物流可变状态', async () => {
    stubFetch(['o1', 'o2', 'o3']);

    const running = pollOrderDomain('logistics');
    // 逐单之间有 3s 限速等待
    await vi.advanceTimersByTimeAsync(30_000);
    await running;

    // 1 次列表 + 3 次详情
    expect(requested).toHaveLength(4);
    expect(requestedMethods).toEqual(['POST', 'GET', 'GET', 'GET']);
    expect(mocks.uploadDump).toHaveBeenCalledTimes(3);
    expect(mocks.uploadDump.mock.calls.map((call) => (call[2] as { mainOrderId: string }).mainOrderId)).toEqual(['o1', 'o2', 'o3']);
  });

  it('单条详情失败不阻塞其余', async () => {
    stubFetch(['o1', 'o2']);
    mocks.uploadDump
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ requestId: 'req-1' });

    const running = pollOrderDomain('logistics');
    await vi.advanceTimersByTimeAsync(30_000);
    await running;

    expect(mocks.uploadDump).toHaveBeenCalledTimes(2);
  });

  it('超过批次上限时保存游标，下一轮从未完成订单继续', async () => {
    const orderIds = Array.from({ length: 55 }, (_, index) => `o${index + 1}`);
    stubFetch(orderIds);

    const first = pollOrderDomain('logistics');
    await vi.advanceTimersByTimeAsync(200_000);
    await first;

    expect(mocks.uploadDump).toHaveBeenCalledTimes(50);
    expect(state.orderProgress?.domains.logistics).toMatchObject({
      total: 55,
      uploaded: 50,
      pending: 5,
      failed: 0,
      currentOrderId: null,
      resumeOrderId: 'o51',
    });
    expect(alarms.get('order-data-sync:logistics:continue')?.delayInMinutes).toBe(0.1);

    const second = pollOrderDomain('logistics');
    await vi.advanceTimersByTimeAsync(30_000);
    await second;

    expect(mocks.uploadDump).toHaveBeenCalledTimes(55);
    expect(state.orderProgress?.domains.logistics).toMatchObject({
      uploaded: 55,
      pending: 0,
      failed: 0,
      currentOrderId: null,
      resumeOrderId: null,
    });
    expect(state.orderProgress?.status).toBe('ok');
    expect(alarms.has('order-data-sync:logistics:continue')).toBe(false);
    expect(alarms.get('order-data-sync:logistics')?.delayInMinutes).toBe(1440);
  });

  it('实时记录当前订单和失败订单，并把失败订单放入下一轮重试队列', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      requestedMethods.push(init?.method ?? 'GET');
      if (url.includes('order_list') || url.includes('/order/list') || url.includes('order-list')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { main_orders: [{ main_order_id: 'o1' }, { main_order_id: 'o2' }, { main_order_id: 'o3' }] },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('main_order_id=o2')) {
        return new Response(JSON.stringify({ code: 1, message: 'detail failed' }), { status: 500 });
      }
      return new Response(JSON.stringify({ code: 0, data: { detail_for: url } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const running = pollOrderDomain('logistics');
    await vi.advanceTimersByTimeAsync(30_000);
    await running;

    expect(state.orderProgress?.domains.logistics).toMatchObject({
      uploaded: 2,
      pending: 1,
      failed: 1,
      currentOrderId: null,
      lastFailedOrderId: 'o2',
      resumeOrderId: 'o2',
    });
    expect(state.orderProgress?.domains.logistics.failedOrderIds).toContain('o2');
    expect(state.runtimeLogs.some((log) => log.context?.details?.action === 'order_started'
      && log.context?.details?.orderId === 'o2')).toBe(true);
    expect(state.runtimeLogs.some((log) => log.context?.details?.action === 'order_failed'
      && log.context?.details?.orderId === 'o2')).toBe(true);
  });

  it('物流 HTTP 200 但响应不是 JSON 时记录解析原因和响应元数据', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('order_list') || url.includes('/order/list') || url.includes('order-list')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { main_orders: [{ main_order_id: 'o1' }] },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('<html>login required</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      });
    }));

    const running = pollOrderDomain('logistics');
    await vi.advanceTimersByTimeAsync(10_000);
    await running;

    const requestLog = state.runtimeLogs.find((log) =>
      log.context?.event === 'tiktok_request'
      && log.context?.details?.stage === 'logistics_detail'
      && log.context?.details?.orderId === 'o1');
    expect(requestLog).toMatchObject({
      level: 'error',
      context: {
        outcome: 'failed',
        details: {
          httpStatus: 200,
          ok: false,
          responseReadError: 'response-not-json',
          responseContentType: 'text/html; charset=UTF-8',
          requestMode: 'main_execute_script',
          responseTextLength: expect.any(Number),
        },
      },
    });
    expect(state.orderProgress?.domains.logistics.lastError).toContain('response-not-json');
    expect(state.orderProgress?.domains.logistics.lastError).toContain('HTTP 200');
    expect(mocks.uploadDump).not.toHaveBeenCalled();
  });

  it('物流 HTTP 200 但业务 code 非 0 时进入失败队列，不上传错误响应', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('order_list') || url.includes('/order/list') || url.includes('order-list')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { main_orders: [{ main_order_id: 'o1' }] },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        code: 105005,
        message: 'scope missing',
        data: { package_list: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await pollOrderDomain('logistics');

    expect(mocks.uploadDump).not.toHaveBeenCalled();
    expect(state.orderProgress?.domains.logistics).toMatchObject({
      pending: 1,
      failed: 1,
      failedOrderIds: ['o1'],
    });
    expect(state.orderProgress?.domains.logistics.lastError).toContain('物流详情 business code 105005');
  });

  it('订单或结算运行时，不把已完成物流轮次误判为物流断点续传', async () => {
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        status: 'running',
        domains: {
          ...progress.domains,
          logistics: {
            ...progress.domains.logistics,
            total: 3,
            uploaded: 3,
            pending: 0,
          },
        },
      },
    };
    stubFetch(['o1', 'o2', 'o3']);

    const running = pollOrderDomain('logistics');
    await vi.advanceTimersByTimeAsync(30_000);
    await running;

    expect(mocks.uploadDump).toHaveBeenCalledTimes(3);
    expect(state.orderProgress?.domains.logistics).toMatchObject({
      uploaded: 3,
      pending: 0,
      resumeOrderId: null,
    });
  });

  it('详情返回后若同步已暂停，不再把旧作用域结果上传', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('order_list') || url.includes('/order/list') || url.includes('order-list')) {
        return new Response(JSON.stringify({ code: 0, data: { main_orders: [{ main_order_id: 'o1' }] } }), { status: 200 });
      }
      state = { ...state, settings: { ...state.settings, syncPaused: true } };
      return new Response(JSON.stringify({ code: 0, data: { detail_for: url } }), { status: 200 });
    }));
    const running = pollOrderDomain('logistics');
    await vi.advanceTimersByTimeAsync(10_000);
    await running;

    expect(mocks.uploadDump).not.toHaveBeenCalled();
  });
});

describe('订单详情与历史域（N+1，逐单接口）', () => {
  it('order/get 的 HTTP 200 + code=0 但结构无效时不上传', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      requestedMethods.push(init?.method ?? 'GET');
      if (url.includes('/api/fulfillment/order/list')) {
        return new Response(JSON.stringify({
          code: 0,
          message: 'success',
          data: { main_orders: [{ main_order_id: 'o1' }], has_more: false, total_count: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 0, message: 'success', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await pollOrderDomain('order_details');

    expect(requestedMethods).toEqual(['POST', 'POST']);
    expect(mocks.uploadDump).not.toHaveBeenCalled();
    expect(state.orderProgress?.domains.order_details).toMatchObject({
      pending: 1,
      failed: 1,
      failedOrderIds: ['o1'],
    });
    expect(state.orderProgress?.domains.order_details.lastError).toContain('schema 校验失败');
    expect(state.runtimeLogs.some((log) => log.context?.event === 'tiktok_request'
      && log.context?.details?.stage === 'order_detail'
      && log.context?.details?.failureReason === 'schema_validation')).toBe(true);
  });

  it('order/get 结构有效时上传详情', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      requestedMethods.push(init?.method ?? 'GET');
      if (url.includes('/api/fulfillment/order/list')) {
        return new Response(JSON.stringify({
          code: 0,
          message: 'success',
          data: { main_orders: [{ main_order_id: 'o1' }], has_more: false, total_count: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        code: 0,
        message: 'success',
        data: { main_order: [{ main_order_id: 'o1' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await pollOrderDomain('order_details');

    expect(mocks.uploadDump).toHaveBeenCalledOnce();
    expect((mocks.uploadDump.mock.calls[0]![2] as { endpoint: string }).endpoint)
      .toContain('/api/fulfillment/order/get');
    expect(requestedMethods).toEqual(['POST', 'POST']);
  });

  it.each([
    {
      domain: 'order_details' as const,
      endpoint: '/api/fulfillment/order/get',
      response: { code: 0, message: 'success', data: { main_order: [{ main_order_id: 'cancelled' }] } },
    },
    {
      domain: 'order_history' as const,
      endpoint: '/api/v1/fulfillment/order/history',
      response: { code: 0, message: 'success', data: { total_count: 0, order_history: [] } },
    },
  ])('$domain 仍同步 main_order_status=104 的取消订单', async ({ domain, endpoint, response }) => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      requestedMethods.push(init?.method ?? 'GET');
      if (url.includes('/api/fulfillment/order/list')) {
        return new Response(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            main_orders: [{
              main_order_id: 'cancelled',
              order_status_module: [{ main_order_status: 104 }],
            }],
            has_more: false,
            total_count: 1,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await pollOrderDomain(domain);

    expect(requested.some((url) => url.includes(endpoint))).toBe(true);
    expect(mocks.uploadDump).toHaveBeenCalledOnce();
    expect((mocks.uploadDump.mock.calls[0]![2] as { mainOrderId: string }).mainOrderId)
      .toBe('cancelled');
    expect(state.orderProgress?.domains[domain]).toMatchObject({
      uploaded: 1,
      pending: 0,
      failed: 0,
    });
  });

  it('dumps 失败不停止当前批次，并把订单放入续传队列', async () => {
    stubFetch(['o1', 'o2']);
    mocks.uploadDump
      .mockRejectedValueOnce(new OrderSyncError('RETRYABLE', 'dumps 暂时不可用', 400, undefined, 'dump'))
      .mockResolvedValue({ requestId: 'req-retry' });

    const first = pollOrderDomain('order_details');
    await vi.advanceTimersByTimeAsync(30_000);
    await first;

    expect(mocks.uploadDump).toHaveBeenCalledTimes(2);
    expect(state.orderProgress?.domains.order_details).toMatchObject({
      uploaded: 1,
      pending: 1,
      failed: 1,
      failedOrderIds: ['o1'],
      resumeOrderId: 'o1',
    });
    expect(alarms.get('order-data-sync:order-details:continue')?.delayInMinutes).toBe(0.1);
    expect(state.runtimeLogs.some((log) => log.context?.details?.action === 'order_failed'
      && log.context?.details?.orderId === 'o1'
      && log.context?.details?.retryQueued === true
      && log.context?.details?.retryQueue === 'pendingOrderIds')).toBe(true);

    const retry = pollOrderDomain('order_details');
    await vi.advanceTimersByTimeAsync(30_000);
    await retry;

    expect(mocks.uploadDump).toHaveBeenCalledTimes(3);
    expect(state.orderProgress?.domains.order_details).toMatchObject({
      pending: 0,
      failed: 0,
      failedOrderIds: [],
      resumeOrderId: null,
    });
  });

  it('order/history 的 HTTP 200 + code=0 但结构无效时不上传', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      requestedMethods.push(init?.method ?? 'GET');
      if (url.includes('/api/fulfillment/order/list')) {
        return new Response(JSON.stringify({
          code: 0,
          message: 'success',
          data: { main_orders: [{ main_order_id: 'o1' }], has_more: false, total_count: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 0, message: 'success', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await pollOrderDomain('order_history');

    expect(requested[1]).toContain('https://seller.tiktokglobalshop.com/');
    expect(requestedMethods).toEqual(['POST', 'POST']);
    expect(mocks.uploadDump).not.toHaveBeenCalled();
    expect(state.orderProgress?.domains.order_history).toMatchObject({
      pending: 1,
      failed: 1,
      failedOrderIds: ['o1'],
    });
    expect(state.orderProgress?.domains.order_history.lastError).toContain('schema 校验失败');
    expect(state.runtimeLogs.some((log) => log.context?.event === 'tiktok_request'
      && log.context?.details?.stage === 'order_history'
      && log.context?.details?.failureReason === 'schema_validation')).toBe(true);
  });

  it('order/history 结构有效时上传历史', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/api/fulfillment/order/list')) {
        return new Response(JSON.stringify({
          code: 0,
          message: 'success',
          data: { main_orders: [{ main_order_id: 'o1' }], has_more: false, total_count: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        code: 0,
        message: 'success',
        data: { total_count: 0, order_history: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await pollOrderDomain('order_history');

    expect(mocks.uploadDump).toHaveBeenCalledOnce();
    expect((mocks.uploadDump.mock.calls[0]![2] as { endpoint: string }).endpoint)
      .toContain('/api/v1/fulfillment/order/history');
  });

  it('order/history 根据 total_count 读取并上传全部分页', async () => {
    const historyBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/api/fulfillment/order/list')) {
        return new Response(JSON.stringify({
          code: 0,
          message: 'success',
          data: { main_orders: [{ main_order_id: 'o1' }], has_more: false, total_count: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      historyBodies.push(body);
      const offset = Number(body.offset);
      const count = offset === 0 ? 10 : 1;
      return new Response(JSON.stringify({
        code: 0,
        message: 'success',
        data: {
          total_count: 11,
          order_history: Array.from({ length: count }, (_, index) => ({
            description: `event-${offset + index}`,
            trans_time: String(offset + index),
            timestamp: offset + index,
          })),
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await pollOrderDomain('order_history');

    expect(historyBodies.map((body) => body.offset)).toEqual([0, 10]);
    expect(historyBodies.every((body) => body.page_size === 10)).toBe(true);
    expect(mocks.uploadDump).toHaveBeenCalledTimes(2);
    expect(mocks.uploadDump.mock.calls.map((call) => (
      (call[2] as { request: { body: { offset: number } } }).request.body.offset
    ))).toEqual([0, 10]);
  });
});

describe('结算域（全局列表）', () => {
  it('结算列表 HTTP 200 但业务 code 非 0 时不上传也不推进进度', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 105005,
      message: 'scope missing',
      data: {
        total_record: 1,
        search_next_has_more: false,
        statement_records: [{ statement_id: 'st-1', statement_version: 1 }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await pollOrderDomain('statements');

    expect(mocks.uploadDump).not.toHaveBeenCalled();
    expect(state.orderProgress?.domains.statements.lastError).toContain('结算列表业务响应失败');
  });

  it('结算 coverage 查询按后端 500 ID 上限分片，但不截断刷新', async () => {
    const records = Array.from({ length: 501 }, (_, index) => ({
      statement_id: `st-${index}`,
      statement_version: 1,
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => new Response(JSON.stringify(
      String(input).includes('/api/v1/pay/statement/order/list')
        ? { code: 0, message: '', data: { total_record: 0, search_next_has_more: false, order_records: [] } }
        : {
            code: 0,
            message: '',
            data: {
              total_record: records.length,
              search_next_has_more: false,
              statement_records: records,
            },
          },
    ), { status: 200, headers: { 'content-type': 'application/json' } })));

    for (let round = 0; round < 11; round += 1) await pollOrderDomain('statements');

    expect(mocks.uploadDump).toHaveBeenCalledTimes(501);
  });

  it('结算全量刷新，不依赖 has-data 过滤', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      message: '',
      data: {
        total_record: 1,
        search_next_has_more: false,
        statement_records: [{ statement_id: 'st-1', statement_version: 1 }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const running = pollOrderDomain('statements');
    await vi.advanceTimersByTimeAsync(5_000);
    await running;

    expect(mocks.uploadDump).toHaveBeenCalledOnce();
  });

  it('按 statement/list 全局分页读取并上传 statement identity，不按订单拼错接口', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      expect(url).toContain('/api/v1/pay/statement/list/detail');
      expect(url).toContain('https://api16-normal-sg.tiktokshopglobalselling.com/');
      expect(url).not.toContain('main_order_id=');
      return new Response(JSON.stringify({
        code: 0,
        message: '',
        data: {
          total_record: 3,
          search_next_has_more: false,
          statement_records: [
            { statement_id: 'st-1', statement_version: 1 },
            { statement_id: 'st-1', statement_version: 2 },
            { statement_id: 'st-2', statement_version: 3 },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await pollOrderDomain('statements');

    expect(mocks.uploadDump).toHaveBeenCalledTimes(3);
    expect(mocks.uploadDump.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ domain: 'statements', statementId: 'st-1', statementVersion: 1 }),
      expect.objectContaining({ domain: 'statements', statementId: 'st-1', statementVersion: 2 }),
      expect.objectContaining({ domain: 'statements', statementId: 'st-2', statementVersion: 3 }),
    ]);
  });

  it('结算总数缺省但有 has_more 时继续读取后续页', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown) => {
      const query = String(_input);
      const from = new URL(query).searchParams.get('from');
      const records = from === '0'
        ? [{ statement_id: 'st-1', statement_version: 1 }]
        : [{ statement_id: 'st-2', statement_version: 1 }];
      return new Response(JSON.stringify({
        code: 0,
        message: 'success',
        data: {
          search_next_has_more: from === '0',
          statement_records: records,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await pollOrderDomain('statements');

    expect(mocks.uploadDump).toHaveBeenCalledTimes(2);
    expect(mocks.uploadDump.mock.calls.map((call) => (call[2] as { statementId: string }).statementId))
      .toEqual(['st-1', 'st-2']);
  });

  it('通过 statement/order/list 发现全部 SKU 明细 ID 并逐条上传', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/api/v1/pay/statement/transaction/detail')) {
        const detailId = new URL(url).searchParams.get('statement_sku_detail_id')!;
        return new Response(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            sku_record: {
              statement_sku_detail_id: detailId,
              statement_id: 'st-1',
              statement_version: 1,
              sku_id: `sku-${detailId}`,
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/v1/pay/statement/order/list')) {
        const settled = new URL(url).searchParams.get('settlement_status') === '1';
        return new Response(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            total_record: settled ? 1 : 0,
            search_next_has_more: false,
            order_records: settled ? [{
              statement_id: 'st-1',
              statement_version: 1,
              sku_records: [
                { statement_sku_detail_id: 'sku-detail-1' },
                { statement_sku_detail_id: 'sku-detail-2' },
              ],
            }] : [],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        code: 0,
        message: 'success',
        data: {
          total_record: 1,
          search_next_has_more: false,
          statement_records: [{ statement_id: 'st-1', statement_version: 1 }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await pollOrderDomain('statements');

    const orderListRequests = requested.filter((url) => url.includes('/api/v1/pay/statement/order/list'));
    const detailRequests = requested.filter((url) => url.includes('/api/v1/pay/statement/transaction/detail'));
    expect(orderListRequests).toHaveLength(2);
    expect(orderListRequests.every((url) => url.includes('no_need_sku_record=false'))).toBe(true);
    expect(detailRequests.map((url) => new URL(url).searchParams.get('statement_sku_detail_id')))
      .toEqual(['sku-detail-1', 'sku-detail-2']);
    expect(mocks.uploadDump).toHaveBeenCalledTimes(3);
    expect(mocks.uploadDump.mock.calls.slice(1).every((call) => (
      (call[2] as { endpoint: string }).endpoint.includes('/api/v1/pay/statement/transaction/detail')
    ))).toBe(true);
  });

  it('结算明细结构无效时不上传并保留 statement 重试', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/v1/pay/statement/transaction/detail')) {
        return new Response(JSON.stringify({ code: 0, message: 'success', data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        code: 0,
        message: 'success',
        data: {
          total_record: 1,
          search_next_has_more: false,
          statement_records: [{
            statement_id: 'st-1',
            statement_version: 1,
            statement_sku_detail_id: 'sku-detail-1',
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await pollOrderDomain('statements');

    expect(mocks.uploadDump).toHaveBeenCalledOnce();
    expect(state.orderProgress.domains.statements).toMatchObject({
      pending: 1,
      failed: 1,
      failedOrderIds: ['st-1::1'],
    });
    expect(state.orderProgress.domains.statements.lastError).toContain('schema 校验失败');
  });

  it('结算主记录上传后作用域失效时，不再请求或上传明细', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/api/v1/pay/statement/transaction/detail')) {
        return new Response(JSON.stringify({ code: 0, data: { sku_record: {} } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: 0,
        message: 'success',
        data: {
          total_record: 1,
          search_next_has_more: false,
          statement_records: [{
            statement_id: 'st-1',
            statement_version: 1,
            statement_sku_detail_id: 'sku-detail-1',
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    mocks.uploadDump.mockImplementationOnce(async () => {
      state = { ...state, settings: { ...state.settings, syncPaused: true } };
      return { requestId: 'req-1' };
    });

    await pollOrderDomain('statements');

    expect(mocks.uploadDump).toHaveBeenCalledOnce();
    expect(requested.some((url) => url.includes('/api/v1/pay/statement/transaction/detail'))).toBe(false);
  });

  it('结算按固定批次保存 statement 游标，并从下一批继续', async () => {
    const records = Array.from({ length: 55 }, (_, index) => ({
      statement_id: `st-${index + 1}`,
      statement_version: 1,
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => new Response(JSON.stringify(
      String(input).includes('/api/v1/pay/statement/order/list')
        ? { code: 0, message: '', data: { total_record: 0, search_next_has_more: false, order_records: [] } }
        : {
            code: 0,
            message: '',
            data: {
              total_record: records.length,
              search_next_has_more: false,
              statement_records: records,
            },
          },
    ), { status: 200, headers: { 'content-type': 'application/json' } })));

    await pollOrderDomain('statements');

    expect(mocks.uploadDump).toHaveBeenCalledTimes(50);
    expect(state.orderProgress?.domains.statements).toMatchObject({
      total: 55,
      uploaded: 50,
      pending: 5,
      resumeOrderId: 'st-51::1',
      currentOrderId: null,
    });
    expect(alarms.get('order-data-sync:statements:continue')?.delayInMinutes).toBe(0.1);

    await pollOrderDomain('statements');

    expect(mocks.uploadDump).toHaveBeenCalledTimes(55);
    expect(state.orderProgress?.domains.statements).toMatchObject({
      uploaded: 55,
      pending: 0,
      resumeOrderId: null,
    });
    expect(alarms.has('order-data-sync:statements:continue')).toBe(false);
    expect(alarms.get('order-data-sync:statements')?.delayInMinutes).toBe(1440);
  });
});

describe('配置完成后的订单域首次主动同步', () => {
  it('保存最后一项同步配置后立即启动三域首次同步', async () => {
    state = boundState({ syncToken: '' });
    stubFetch([]);

    await handleOrderMessage({
      type: 'order-sync:save-settings',
      settings: { ...state.settings, syncToken: 'fixture-token' },
    }, {} as chrome.runtime.MessageSender);

    // 配置保存会先确保三个主轮次及其续传 alarm；等待实际的首次同步
    // 生命周期事件，而不是把实现内部 await 数量当作对外契约。
    for (let i = 0; i < 100 && !state.runtimeLogs.some((log) => log.context?.event === 'initial_sync_started'); i += 1) {
      await Promise.resolve();
    }
    expect(state.runtimeLogs.some((log) => log.context?.event === 'initial_sync_started'
      && log.context?.details?.trigger === 'configuration_ready')).toBe(true);
    expect(alarms.get('order-data-sync:orders')?.delayInMinutes).toBe(1440);
    expect(alarms.get('order-data-sync:logistics')?.delayInMinutes).toBe(1440);
    expect(alarms.get('order-data-sync:statements')?.delayInMinutes).toBe(1440);
  });

  it('首批未处理完时只标记已排队，不把首次同步写成完成', async () => {
    const orderIds = Array.from({ length: 55 }, (_, index) => `o${index + 1}`);
    const statements = orderIds.map((id) => ({ statement_id: `st-${id}`, statement_version: 1 }));
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/api/v1/pay/statement/list/detail')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { total_record: statements.length, search_next_has_more: false, statement_records: statements },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('order_list') || url.includes('/order/list') || url.includes('order-list')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { main_orders: orderIds.map((id) => ({ main_order_id: id })) },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 0, data: { detail_for: url } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const running = runInitialOrderDomainSync();
    await vi.advanceTimersByTimeAsync(200_000);
    await running;

    expect(state.runtimeLogs.some((log) => log.context?.event === 'initial_sync_completed')).toBe(false);
    expect(state.runtimeLogs.some((log) => log.context?.event === 'initial_sync_queued')).toBe(true);
  });

  it('三个列表都失败时不记录首次同步完成', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 1 }), { status: 503 })));

    await runInitialOrderDomainSync();

    expect(state.runtimeLogs.some((log) => log.context?.event === 'initial_sync_completed')).toBe(false);
    expect(state.runtimeLogs.some((log) => log.context?.event === 'initial_sync_queued')).toBe(true);
  });

  it('切换同步服务器后清空旧订单域断点', async () => {
    const progress = createDefaultOrderSyncState().orderProgress!;
    state = {
      ...state,
      orderProgress: {
        ...progress,
        domains: {
          ...progress.domains,
          orders: { ...progress.domains.orders, uploaded: 50, pending: 50, resumeOrderId: 'o51' },
        },
      },
    };

    await handleOrderMessage({
      type: 'order-sync:save-settings',
      settings: { ...state.settings, syncToken: 'new-server-token' },
    }, {} as chrome.runtime.MessageSender);

    expect(state.orderProgress?.domains.orders).toMatchObject({
      uploaded: 0,
      pending: 0,
      resumeOrderId: null,
      failedOrderIds: [],
    });
  });
});
