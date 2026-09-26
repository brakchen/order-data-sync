import { describe, expect, it } from 'vitest';
import {
  createOrderListRequestBody,
  createLogisticDetailQuery,
  createOrderGetRequestBody,
  createOrderHistoryQuery,
  tiktokOrderEndpointUrl,
  TIKTOK_ORDER_ENDPOINT_PATHS,
} from '../src/core/tiktok-order-endpoints';
import {
  OrderListRequestBodySchema,
  OrderListResponseSchema,
  LogisticDetailResponseSchema,
  OrderGetResponseSchema,
  OrderHistoryResponseSchema,
  extractMainOrderIds,
  extractSkuToProductIdMap,
} from '../src/core/tiktok-order-endpoint-schemas';

// ─── Order endpoints ─────────────────────────────────────────────────

describe('TIKTOK_ORDER_ENDPOINT_PATHS', () => {
  it('has the expected paths', () => {
    expect(TIKTOK_ORDER_ENDPOINT_PATHS['order-list']).toBe('/api/fulfillment/order/list');
    expect(TIKTOK_ORDER_ENDPOINT_PATHS['logistic-detail']).toBe('/api/v1/fulfillment/logistic_detail/list');
    expect(TIKTOK_ORDER_ENDPOINT_PATHS['order-get']).toBe('/api/fulfillment/order/get');
    expect(TIKTOK_ORDER_ENDPOINT_PATHS['order-history']).toBe('/api/v1/fulfillment/order/history');
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

describe('createOrderGetRequestBody', () => {
  it('builds body with single order id', () => {
    expect(createOrderGetRequestBody(['586055106746877269'])).toEqual({
      main_order_id: ['586055106746877269'],
    });
  });

  it('builds body with multiple order ids', () => {
    expect(createOrderGetRequestBody(['aaa', 'bbb', 'ccc'])).toEqual({
      main_order_id: ['aaa', 'bbb', 'ccc'],
    });
  });

  it('builds body with empty array', () => {
    expect(createOrderGetRequestBody([])).toEqual({ main_order_id: [] });
  });
});

describe('createOrderHistoryQuery', () => {
  it('builds main_order_id query param', () => {
    expect(createOrderHistoryQuery('586055106746877269')).toEqual({
      main_order_id: '586055106746877269',
    });
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

// ─── Order get ───────────────────────────────────────────────────────

describe('OrderGetResponseSchema', () => {
  const validResponse = {
    code: 0,
    message: 'success',
    data: {
      main_order: [{
        main_order_id: '586172232072332674',
        trade_order_module: {
          main_order_id: '586172232072332674',
          create_time: '1789923447',
          payment_time: '1790349731',
          sale_region: 'VN',
        },
        order_status_module: [{
          order_line_id: '586172232072398210',
          main_order_status: 102,
          main_sub_order_status: 310,
        }],
        sku_module: [{
          sku_id: '1737303421188539522',
          product_id: '1737303446962537602',
          product_name: 'Áo Polo Nam',
          sku_name: 'Nâu, XL',
          quantity: 1,
          sku_unit_price: { format_price: '539.310₫', price_val: '539310', currency: 'VND', symbol: '₫' },
          sku_total_price: { format_price: '539.310₫', price_val: '539310.00', currency: 'VND', symbol: '₫' },
        }],
        fulfillment_module: [{
          fulfill_unit_id: '1211732997698717058',
          fulfillment_status_v2: 17000,
        }],
        delivery_module: [{
          fulfill_unit_id: '1211732997698717058',
          tracking_no: '857661067034',
          warehouse_region: 'CN',
          buyer_region: 'VN',
          shipment_provider_info: { id: '7439297584469903122', name: 'Wise Express' },
        }],
        price_module: {
          main_order_id: '586172232072332674',
          sub_total: { format_price: '539.310₫', price_val: '539310', currency: 'VND', symbol: '₫' },
          grand_total: { format_price: '539.310₫', price_val: '539310', currency: 'VND', symbol: '₫' },
        },
        buyer_info_module: {
          buyer_nickname: 'm**********6',
          shipping_address: { address_id: '7792906262497996804' },
        },
        reverse_module: [{
          reverse_order_id: '4042453493777204610',
          reverse_status: 4,
          reverse_reason: '商品与描述不符',
        }],
        logistics_info_module: [{
          fulfill_unit_id: '1211732997698717058',
          logistics_detail_item: { timestamp: 1790349667000, display_msg: '你的包裹已送达！' },
        }],
      }],
    },
  };

  it('validates a well-formed response', () => {
    expect(OrderGetResponseSchema.safeParse(validResponse).success).toBe(true);
  });

  it('rejects missing main_order array', () => {
    const invalid = { code: 0, message: 'success', data: {} };
    expect(OrderGetResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects wrong code type', () => {
    const invalid = { ...validResponse, code: 'not-a-number' };
    expect(OrderGetResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('accepts minimal row (only main_order_id)', () => {
    const minimal = {
      code: 0,
      message: 'success',
      data: { main_order: [{ main_order_id: '123' }] },
    };
    expect(OrderGetResponseSchema.safeParse(minimal).success).toBe(true);
  });
});

// ─── Order history ───────────────────────────────────────────────────

describe('OrderHistoryResponseSchema', () => {
  const validResponse = {
    code: 0,
    message: 'success',
    data: {
      total_count: 7,
      order_history: [
        {
          description: '退款完成',
          trans_time: '2026/9/26 18:56:17',
          timestamp: 1790420177,
        },
        {
          description: '客户已将退货包裹寄送给商家',
          trans_time: '2026/9/26 18:56:13',
          timestamp: 1790420173,
        },
        {
          description: '客户已提交退货/退款申请',
          trans_time: '2026/9/26 00:51:56',
          timestamp: 1790355116,
          detail: '商品与描述不符',
          elements: [{
            title: '其他信息',
            content: 'Đồ đểu shop...',
            media_items: [{
              picture: {
                height: 200,
                width: 200,
                uri: 'tos-alisg-i-aphluv4xwc-sg/efcdcb8e3b394d7a85444431c36f7f2e',
                url_list: ['https://p16-oec-sg.ibyteimg.com/...'],
              },
            }],
          }],
        },
        {
          description: '客户创建订单',
          trans_time: '2026/9/21 00:57:27',
          timestamp: 1789923447,
        },
      ],
    },
  };

  it('validates a well-formed response', () => {
    expect(OrderHistoryResponseSchema.safeParse(validResponse).success).toBe(true);
  });

  it('rejects missing order_history array', () => {
    const invalid = { code: 0, message: 'success', data: { total_count: 0 } };
    expect(OrderHistoryResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects missing total_count', () => {
    const invalid = { code: 0, message: 'success', data: { order_history: [] } };
    expect(OrderHistoryResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('accepts empty order_history', () => {
    const empty = { code: 0, message: 'success', data: { total_count: 0, order_history: [] } };
    expect(OrderHistoryResponseSchema.safeParse(empty).success).toBe(true);
  });

  it('accepts history items without detail/elements', () => {
    const simple = {
      code: 0,
      message: 'success',
      data: {
        total_count: 1,
        order_history: [{ description: '客户创建订单', trans_time: '2026/9/21', timestamp: 1789923447 }],
      },
    };
    expect(OrderHistoryResponseSchema.safeParse(simple).success).toBe(true);
  });
});
