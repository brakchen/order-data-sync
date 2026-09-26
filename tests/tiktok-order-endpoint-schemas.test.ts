import { describe, expect, it } from 'vitest';
import {
  createOrderListRequestBody,
  createLogisticDetailQuery,
  tiktokOrderEndpointUrl,
  TIKTOK_ORDER_ENDPOINT_PATHS,
} from '../src/core/tiktok-order-endpoints';
import {
  OrderListRequestBodySchema,
  OrderListResponseSchema,
  LogisticDetailResponseSchema,
  extractMainOrderIds,
  extractSkuToProductIdMap,
} from '../src/core/tiktok-order-endpoint-schemas';

// ─── Order endpoints ─────────────────────────────────────────────────

describe('TIKTOK_ORDER_ENDPOINT_PATHS', () => {
  it('has the expected paths', () => {
    expect(TIKTOK_ORDER_ENDPOINT_PATHS['order-list']).toBe('/api/fulfillment/order/list');
    expect(TIKTOK_ORDER_ENDPOINT_PATHS['logistic-detail']).toBe('/api/v1/fulfillment/logistic_detail/list');
  });
});

describe('createOrderListRequestBody', () => {
  it('uses observed defaults', () => {
    const body = createOrderListRequestBody({});
    expect(body).toEqual({
      search_condition: { condition_list: {} },
      offset: 0,
      count: 20,
      sort_info: '6',
      search_cursor: '',
      pagination_type: 0,
    });
  });

  it('overrides defaults with provided values', () => {
    const body = createOrderListRequestBody({
      offset: 20,
      count: 50,
      searchCursor: 'abc123',
      conditionList: { status: ['shipped'] },
    });
    expect(body).toMatchObject({
      offset: 20,
      count: 50,
      search_cursor: 'abc123',
      search_condition: { condition_list: { status: ['shipped'] } },
    });
  });

  it('produces a body that passes OrderListRequestBodySchema', () => {
    const body = createOrderListRequestBody({});
    expect(OrderListRequestBodySchema.safeParse(body).success).toBe(true);
  });
});

describe('createLogisticDetailQuery', () => {
  it('builds main_order_id query param', () => {
    expect(createLogisticDetailQuery('1234567890')).toEqual({ main_order_id: '1234567890' });
  });
});

describe('tiktokOrderEndpointUrl', () => {
  it('composes URL with identity params', () => {
    const url = tiktokOrderEndpointUrl(
      'https://api16-normal-sg.tiktokshopglobalselling.com',
      'order-list',
      { sellerId: '12345', region: 'TH' },
    );
    expect(url).toContain('/api/fulfillment/order/list');
    expect(url).toContain('oec_seller_id=12345');
    expect(url).toContain('seller_id=12345');
    expect(url).toContain('aid=6556');
  });

  it('appends extra query params', () => {
    const url = tiktokOrderEndpointUrl(
      'https://api16-normal-sg.tiktokshopglobalselling.com',
      'logistic-detail',
      { sellerId: '12345' },
      { main_order_id: '999' },
    );
    expect(url).toContain('main_order_id=999');
  });
});

// ─── Order schemas ───────────────────────────────────────────────────

describe('OrderListResponseSchema', () => {
  const validResponse = {
    code: 0,
    message: 'success',
    data: {
      offset: 0,
      count: 20,
      total_count: 100,
      main_orders: [
        {
          main_order_id: 'order-1',
          sku_module: [{ sku_id: 'sku-1', product_id: 'prod-1' }],
          fulfill_line_module: [{ sku_id: 'sku-1', product_id: 'prod-1' }],
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

  it('validates a well-formed response', () => {
    expect(OrderListResponseSchema.safeParse(validResponse).success).toBe(true);
  });

  it('rejects missing main_orders', () => {
    const invalid = { ...validResponse, data: { ...validResponse.data, main_orders: undefined } };
    expect(OrderListResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects wrong code type', () => {
    const invalid = { ...validResponse, code: 'not-a-number' };
    expect(OrderListResponseSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('extractMainOrderIds', () => {
  it('extracts all main_order_ids', () => {
    const response = {
      code: 0, message: 'success',
      data: {
        offset: 0, count: 2, total_count: 2,
        main_orders: [
          { main_order_id: 'aaa' },
          { main_order_id: 'bbb' },
        ],
      },
    };
    expect(extractMainOrderIds(response)).toEqual(['aaa', 'bbb']);
  });

  it('returns empty array for invalid response', () => {
    expect(extractMainOrderIds({})).toEqual([]);
    expect(extractMainOrderIds(null)).toEqual([]);
  });
});

describe('extractSkuToProductIdMap', () => {
  it('builds map from sku_module', () => {
    const response = {
      code: 0, message: 'success',
      data: {
        offset: 0, count: 1, total_count: 1,
        main_orders: [{
          main_order_id: 'order-1',
          sku_module: [{ sku_id: 'sku-1', product_id: 'prod-1' }],
        }],
      },
    };
    const map = extractSkuToProductIdMap(response);
    expect(map.get('sku-1')).toBe('prod-1');
  });

  it('builds map from fulfill_line_module as fallback', () => {
    const response = {
      code: 0, message: 'success',
      data: {
        offset: 0, count: 1, total_count: 1,
        main_orders: [{
          main_order_id: 'order-1',
          fulfill_line_module: [{ sku_id: 'sku-2', product_id: 'prod-2' }],
        }],
      },
    };
    const map = extractSkuToProductIdMap(response);
    expect(map.get('sku-2')).toBe('prod-2');
  });

  it('first occurrence wins for duplicate sku_id', () => {
    const response = {
      code: 0, message: 'success',
      data: {
        offset: 0, count: 1, total_count: 1,
        main_orders: [{
          main_order_id: 'order-1',
          sku_module: [
            { sku_id: 'sku-1', product_id: 'prod-first' },
            { sku_id: 'sku-1', product_id: 'prod-second' },
          ],
        }],
      },
    };
    const map = extractSkuToProductIdMap(response);
    expect(map.get('sku-1')).toBe('prod-first');
  });

  it('returns empty map for invalid response', () => {
    expect(extractSkuToProductIdMap({}).size).toBe(0);
  });
});

// ─── Logistic detail ─────────────────────────────────────────────────

describe('LogisticDetailResponseSchema', () => {
  it('validates a well-formed response', () => {
    const response = {
      code: 0, message: 'success',
      data: {
        package_list: [{
          main_order_id: 'order-1',
          package_id: 'pkg-1',
          tracking_no: 'TRK123',
          logistic_supplier: 'Flash',
          logistic_detail: { track_list: [{ time: '2026-09-08', track_status: 'shipped' }] },
        }],
      },
    };
    expect(LogisticDetailResponseSchema.safeParse(response).success).toBe(true);
  });

  it('rejects missing package_list', () => {
    const response = { code: 0, message: 'success', data: {} };
    expect(LogisticDetailResponseSchema.safeParse(response).success).toBe(false);
  });
});
