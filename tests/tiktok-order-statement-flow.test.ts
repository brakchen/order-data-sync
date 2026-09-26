import { describe, expect, it } from 'vitest';
import { fetchOrderWithLogistics, type OrderFlowHandlers } from '../src/core/tiktok-order-flow';
import {
  fetchStatementList,
  fetchStatementTransactionDetail,
  type StatementFlowHandlers,
} from '../src/core/tiktok-statement-flow';
import {
  buildSkuToProductIdMap,
  resolveProductId,
  mergeSkuToProductIdMap,
} from '../src/core/tiktok-product-resolution';
import type { OrderListRow } from '../src/core/tiktok-order-endpoint-schemas';

// ─── Helpers ─────────────────────────────────────────────────────────

function mockFetchJson(routes: Record<string, { status: number; body: unknown }>): OrderFlowHandlers & StatementFlowHandlers {
  return {
    fetchJson: async (url: string) => {
      for (const [pattern, response] of Object.entries(routes)) {
        if (url.includes(pattern)) return response;
      }
      throw new Error(`No mock route for: ${url}`);
    },
  };
}

const ORIGIN = 'https://api16-normal-sg.tiktokshopglobalselling.com';
const IDENTITY = { sellerId: '12345', region: 'TH' };

// ─── Order flow ──────────────────────────────────────────────────────

describe('fetchOrderWithLogistics', () => {
  const orderListResponse = {
    code: 0, message: 'success',
    data: {
      offset: 0, count: 2, total_count: 2,
      main_orders: [
        {
          main_order_id: 'order-1',
          sku_module: [{ sku_id: 'sku-1', product_id: 'prod-1' }],
        },
        {
          main_order_id: 'order-2',
          sku_module: [{ sku_id: 'sku-2', product_id: 'prod-2' }],
        },
      ],
      next_cursor_token: 'cursor-abc',
      has_more: true,
    },
  };

  const logisticResponse1 = {
    code: 0, message: 'success',
    data: { package_list: [{ main_order_id: 'order-1', package_id: 'pkg-1' }] },
  };
  const logisticResponse2 = {
    code: 0, message: 'success',
    data: { package_list: [{ main_order_id: 'order-2', package_id: 'pkg-2' }] },
  };

  it('fetches orders then logistics sequentially', async () => {
    const handlers = mockFetchJson({
      '/api/fulfillment/order/list': { status: 200, body: orderListResponse },
      'main_order_id=order-1': { status: 200, body: logisticResponse1 },
      'main_order_id=order-2': { status: 200, body: logisticResponse2 },
    });

    const result = await fetchOrderWithLogistics(handlers, ORIGIN, IDENTITY);
    expect(result.orders).toHaveLength(2);
    expect(result.logistics).toHaveLength(2);
    expect(result.logistics[0]!.ok).toBe(true);
    expect(result.logistics[1]!.ok).toBe(true);
    expect(result.totalCount).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('cursor-abc');
  });

  it('builds skuToProductId map from order response', async () => {
    const handlers = mockFetchJson({
      '/api/fulfillment/order/list': { status: 200, body: orderListResponse },
      'main_order_id=order-1': { status: 200, body: logisticResponse1 },
      'main_order_id=order-2': { status: 200, body: logisticResponse2 },
    });

    const result = await fetchOrderWithLogistics(handlers, ORIGIN, IDENTITY);
    expect(result.skuToProductId.get('sku-1')).toBe('prod-1');
    expect(result.skuToProductId.get('sku-2')).toBe('prod-2');
  });

  it('records per-order logistics failure without throwing', async () => {
    const handlers = mockFetchJson({
      '/api/fulfillment/order/list': { status: 200, body: orderListResponse },
      'main_order_id=order-1': { status: 200, body: logisticResponse1 },
      // order-2 has no mock → will throw
    });

    const result = await fetchOrderWithLogistics(handlers, ORIGIN, IDENTITY);
    expect(result.logistics[0]!.ok).toBe(true);
    expect(result.logistics[1]!.ok).toBe(false);
    expect(result.logistics[1]!.error).toContain('No mock route');
  });

  it('records per-order logistics schema failure without throwing', async () => {
    const handlers = mockFetchJson({
      '/api/fulfillment/order/list': { status: 200, body: orderListResponse },
      'main_order_id=order-1': { status: 200, body: { code: 0, message: 'success', data: {} } },
      'main_order_id=order-2': { status: 200, body: logisticResponse2 },
    });

    const result = await fetchOrderWithLogistics(handlers, ORIGIN, IDENTITY);
    expect(result.logistics[0]!.ok).toBe(false);
    expect(result.logistics[0]!.error).toContain('schema validation');
    expect(result.logistics[1]!.ok).toBe(true);
  });

  it('records non-2xx logistics responses as failures', async () => {
    const handlers = mockFetchJson({
      '/api/fulfillment/order/list': { status: 200, body: orderListResponse },
      'main_order_id=order-1': { status: 401, body: { code: 401, message: 'unauthorized' } },
      'main_order_id=order-2': { status: 200, body: logisticResponse2 },
    });

    const result = await fetchOrderWithLogistics(handlers, ORIGIN, IDENTITY);
    expect(result.logistics[0]).toMatchObject({ ok: false, error: 'logistic_detail HTTP 401' });
    expect(result.logistics[1]!.ok).toBe(true);
  });

  it('records non-zero logistics business codes as failures', async () => {
    const handlers = mockFetchJson({
      '/api/fulfillment/order/list': { status: 200, body: orderListResponse },
      'main_order_id=order-1': { status: 200, body: { code: 105005, message: 'scope missing', data: { package_list: [] } } },
      'main_order_id=order-2': { status: 200, body: logisticResponse2 },
    });

    const result = await fetchOrderWithLogistics(handlers, ORIGIN, IDENTITY);
    expect(result.logistics[0]).toMatchObject({
      ok: false,
      error: 'logistic_detail business code 105005: scope missing',
    });
    expect(result.logistics[1]!.ok).toBe(true);
  });

  it('throws when order/list response fails schema validation', async () => {
    const handlers = mockFetchJson({
      '/api/fulfillment/order/list': { status: 200, body: { code: 0, message: 'success', data: {} } },
    });

    await expect(fetchOrderWithLogistics(handlers, ORIGIN, IDENTITY)).rejects.toThrow('schema validation');
  });

  it('handles empty order list', async () => {
    const emptyResponse = {
      code: 0, message: 'success',
      data: { offset: 0, count: 20, total_count: 0, main_orders: [] },
    };
    const handlers = mockFetchJson({
      '/api/fulfillment/order/list': { status: 200, body: emptyResponse },
    });

    const result = await fetchOrderWithLogistics(handlers, ORIGIN, IDENTITY);
    expect(result.orders).toHaveLength(0);
    expect(result.logistics).toHaveLength(0);
    expect(result.skuToProductId.size).toBe(0);
  });

  it('passes all explicit opts through to the request', async () => {
    const controller = new AbortController();
    let capturedUrl = '';
    let capturedBody = '';
    const handlers: OrderFlowHandlers = {
      fetchJson: async (url, init) => {
        capturedUrl = url;
        capturedBody = init?.body ?? '';
        return { status: 200, body: {
          code: 0, message: 'success',
          data: { offset: 0, count: 50, total_count: 0, main_orders: [] },
        } };
      },
    };

    await fetchOrderWithLogistics(handlers, ORIGIN, IDENTITY, {
      offset: 20,
      count: 50,
      searchCursor: 'cursor-abc',
      paginationType: 1,
      conditionList: { status: ['shipped'] },
      signal: controller.signal,
    });

    expect(capturedUrl).toContain('/api/fulfillment/order/list');
    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body.offset).toBe(20);
    expect(body.count).toBe(50);
    expect(body.search_cursor).toBe('cursor-abc');
    expect(body.pagination_type).toBe(1);
  });

  it('passes signal to logistics fetch when provided', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const orderResponse = {
      code: 0, message: 'success',
      data: {
        offset: 0, count: 1, total_count: 1,
        main_orders: [{ main_order_id: 'order-1', sku_module: [] }],
      },
    };
    const handlers: OrderFlowHandlers = {
      fetchJson: async (url, init) => {
        if (url.includes('logistic_detail')) {
          capturedSignal = init?.signal;
          return { status: 200, body: { code: 0, message: 'success', data: { package_list: [] } } };
        }
        return { status: 200, body: orderResponse };
      },
    };

    await fetchOrderWithLogistics(handlers, ORIGIN, IDENTITY, { signal: controller.signal });
    expect(capturedSignal).toBe(controller.signal);
  });

  it('handles non-Error thrown from logistics fetch', async () => {
    const orderResponse = {
      code: 0, message: 'success',
      data: {
        offset: 0, count: 1, total_count: 1,
        main_orders: [{ main_order_id: 'order-1', sku_module: [] }],
      },
    };
    const handlers: OrderFlowHandlers = {
      fetchJson: async (url) => {
        if (url.includes('logistic_detail')) throw 'string-error';
        return { status: 200, body: orderResponse };
      },
    };

    const result = await fetchOrderWithLogistics(handlers, ORIGIN, IDENTITY);
    expect(result.logistics[0]!.ok).toBe(false);
    expect(result.logistics[0]!.error).toBe('string-error');
  });
});

// ─── Statement flow ──────────────────────────────────────────────────

describe('fetchStatementList', () => {
  const listResponse = {
    code: 0, message: 'success',
    data: {
      search_next_cursor: 'cursor-next',
      search_next_has_more: true,
      search_previous_cursor: 'cursor-prev',
      search_previous_has_more: false,
      total_record: 25,
      statement_records: [
        { statement_id: 'stmt-1', statement_version: 0 },
        { statement_id: 'stmt-2', statement_version: 0 },
      ],
    },
  };

  it('fetches and validates statement list', async () => {
    const handlers = mockFetchJson({
      '/api/v1/pay/statement/list/detail': { status: 200, body: listResponse },
    });

    const result = await fetchStatementList(handlers, ORIGIN, IDENTITY);
    expect(result.statements).toHaveLength(2);
    expect(result.totalRecord).toBe(25);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('cursor-next');
    expect(result.previousHasMore).toBe(false);
  });

  it('handles statement list without optional cursor fields', async () => {
    const minimalResponse = {
      code: 0, message: 'success',
      data: {
        statement_records: [{ statement_id: 'stmt-1', statement_version: 0 }],
      },
    };
    const handlers = mockFetchJson({
      '/api/v1/pay/statement/list/detail': { status: 200, body: minimalResponse },
    });

    const result = await fetchStatementList(handlers, ORIGIN, IDENTITY);
    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
    expect(result.previousCursor).toBeNull();
    expect(result.previousHasMore).toBe(false);
    expect(result.totalRecord).toBe(0);
  });

  it('throws on invalid response', async () => {
    const handlers = mockFetchJson({
      '/api/v1/pay/statement/list/detail': { status: 200, body: { code: 0, data: {} } },
    });

    await expect(fetchStatementList(handlers, ORIGIN, IDENTITY)).rejects.toThrow('schema validation');
  });
});

describe('fetchStatementTransactionDetail', () => {
  const detailResponse = {
    code: 0, message: 'success',
    data: {
      sku_record: {
        statement_sku_detail_id: 'sku-detail-1',
        statement_id: 'stmt-1',
        statement_version: 0,
        sku_id: 'sku-1',
        product_name: 'Test Product',
        sku_name: 'Test SKU',
      },
    },
    seller_web_cut_flow: true,
    seller_app_cut_flow: false,
  };

  it('fetches and validates a detail response', async () => {
    const handlers = mockFetchJson({
      'statement_sku_detail_id=sku-detail-1': { status: 200, body: detailResponse },
    });

    const result = await fetchStatementTransactionDetail(handlers, ORIGIN, IDENTITY, 'sku-detail-1');
    expect(result.ok).toBe(true);
    expect(result.record?.statement_sku_detail_id).toBe('sku-detail-1');
    expect(result.sellerWebCutFlow).toBe(true);
    expect(result.sellerAppCutFlow).toBe(false);
  });

  it('returns error on invalid response', async () => {
    const handlers = mockFetchJson({
      'statement_sku_detail_id=bad': { status: 200, body: { code: 0, data: {} } },
    });

    const result = await fetchStatementTransactionDetail(handlers, ORIGIN, IDENTITY, 'bad');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('schema validation');
  });

  it('returns error on network failure', async () => {
    const handlers: StatementFlowHandlers = {
      fetchJson: async () => { throw new Error('network down'); },
    };

    const result = await fetchStatementTransactionDetail(handlers, ORIGIN, IDENTITY, 'any');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('network down');
  });

  it('handles detail response without cut_flow booleans', async () => {
    const noCutFlow = {
      code: 0, message: 'success',
      data: {
        sku_record: {
          statement_sku_detail_id: 'sku-detail-1',
          statement_id: 'stmt-1',
          statement_version: 0,
          sku_id: 'sku-1',
        },
      },
    };
    const handlers = mockFetchJson({
      'statement_sku_detail_id=sku-detail-1': { status: 200, body: noCutFlow },
    });

    const result = await fetchStatementTransactionDetail(handlers, ORIGIN, IDENTITY, 'sku-detail-1');
    expect(result.ok).toBe(true);
    expect(result.sellerWebCutFlow).toBeUndefined();
    expect(result.sellerAppCutFlow).toBeUndefined();
  });

  it('passes signal to fetchJson when provided', async () => {
    let capturedSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const handlers: StatementFlowHandlers = {
      fetchJson: async (_url, init) => {
        capturedSignal = init?.signal;
        return { status: 200, body: detailResponse };
      },
    };

    await fetchStatementTransactionDetail(handlers, ORIGIN, IDENTITY, 'sku-detail-1', {
      signal: controller.signal,
    });
    expect(capturedSignal).toBe(controller.signal);
  });

  it('passes through explicit opts to query params', async () => {
    let capturedUrl = '';
    const handlers: StatementFlowHandlers = {
      fetchJson: async (url) => {
        capturedUrl = url;
        return { status: 200, body: detailResponse };
      },
    };

    await fetchStatementTransactionDetail(handlers, ORIGIN, IDENTITY, 'sku-detail-1', {
      statementVersion: 1,
      terminalType: 2,
      pageType: 10,
    });
    expect(capturedUrl).toContain('statement_version=1');
    expect(capturedUrl).toContain('terminal_type=2');
    expect(capturedUrl).toContain('page_type=10');
  });
});

// ─── Product resolution ──────────────────────────────────────────────

describe('buildSkuToProductIdMap', () => {
  it('builds map from order rows', () => {
    const rows: OrderListRow[] = [
      { main_order_id: 'o1', sku_module: [{ sku_id: 's1', product_id: 'p1' }] },
      { main_order_id: 'o2', fulfill_line_module: [{ sku_id: 's2', product_id: 'p2' }] },
    ];
    const map = buildSkuToProductIdMap(rows);
    expect(map.get('s1')).toBe('p1');
    expect(map.get('s2')).toBe('p2');
  });

  it('handles empty input', () => {
    expect(buildSkuToProductIdMap([]).size).toBe(0);
  });

  it('handles rows without sku_module or fulfill_line_module', () => {
    const rows: OrderListRow[] = [{ main_order_id: 'o1' }];
    expect(buildSkuToProductIdMap(rows).size).toBe(0);
  });
});

describe('resolveProductId', () => {
  it('resolves a known sku_id', () => {
    const map = new Map([['sku-1', 'prod-1']]);
    expect(resolveProductId('sku-1', map)).toBe('prod-1');
  });

  it('returns undefined for unknown sku_id', () => {
    const map = new Map([['sku-1', 'prod-1']]);
    expect(resolveProductId('unknown', map)).toBeUndefined();
  });
});

describe('mergeSkuToProductIdMap', () => {
  it('merges without overwriting existing keys', () => {
    const target = new Map([['s1', 'p1']]);
    const source = new Map([['s1', 'p1-new'], ['s2', 'p2']]);
    mergeSkuToProductIdMap(target, source);
    expect(target.get('s1')).toBe('p1');
    expect(target.get('s2')).toBe('p2');
  });
});
