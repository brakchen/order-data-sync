/**
 * Pure-function flow for order → logistics chain.
 *
 * No chrome.* imports. The caller injects a fetch handler (typically the
 * bound-page MAIN-world fetch via chrome.scripting.executeScript).
 *
 * Deferred decisions (per user): no concurrency, no retry, no rate-limit.
 */

import {
  TIKTOK_ORDER_ENDPOINT_PATHS,
  createOrderListRequestBody,
  tiktokOrderEndpointUrl,
} from './tiktok-order-endpoints';
import {
  extractMainOrderIds,
  extractSkuToProductIdMap,
  OrderListResponseSchema,
  LogisticDetailResponseSchema,
} from './tiktok-order-endpoint-schemas';
import type { OrderListRow } from './tiktok-order-endpoint-schemas';

// ─── Handler interface (injected) ────────────────────────────────────

export interface OrderFlowHandlers {
  fetchJson: (
    url: string,
    init?: { method?: string; body?: string; signal?: AbortSignal },
  ) => Promise<{ status: number; body: unknown }>;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface OrderFlowIdentity {
  sellerId: string;
  region: string;
}

export interface OrderWithLogisticsResult {
  /** Validated order-list rows (opaque passthrough). */
  orders: OrderListRow[];
  /** Per-order logistics results, in the same order as orders. */
  logistics: Array<{
    mainOrderId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }>;
  /** sku_id → product_id map extracted from the order rows. */
  skuToProductId: Map<string, string>;
  /** Pagination state from the first page. */
  totalCount: number;
  hasMore: boolean;
  nextCursor: string | null;
}

// ─── Flow ────────────────────────────────────────────────────────────

/** API host for fulfillment/logistic endpoints (differs from Seller Center UI host). */
const TIKTOK_API_ORIGIN = 'https://api16-normal-sg.tiktokshopglobalselling.com';

/**
 * Fetch page 1 of order/list, then sequentially fetch logistic_detail/list
 * for each main_order_id. Serial — no concurrency (deferred decision).
 *
 * Does NOT paginate order/list beyond page 1; the caller can drive
 * subsequent pages by calling again with an updated offset/cursor.
 */
export async function fetchOrderWithLogistics(
  handlers: OrderFlowHandlers,
  origin: string,
  identity: OrderFlowIdentity,
  opts: {
    offset?: number;
    count?: number;
    searchCursor?: string;
    paginationType?: number;
    conditionList?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): Promise<OrderWithLogisticsResult> {
  // Step 1: fetch order list
  const orderBody = createOrderListRequestBody({
    ...(opts.offset === undefined ? {} : { offset: opts.offset }),
    ...(opts.count === undefined ? {} : { count: opts.count }),
    ...(opts.searchCursor === undefined ? {} : { searchCursor: opts.searchCursor }),
    ...(opts.paginationType === undefined ? {} : { paginationType: opts.paginationType }),
    ...(opts.conditionList === undefined ? {} : { conditionList: opts.conditionList }),
  });
  const orderUrl = tiktokOrderEndpointUrl(origin, 'order-list', identity);
  const orderResponse = await handlers.fetchJson(orderUrl, {
    method: 'POST',
    body: JSON.stringify(orderBody),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  // §2.5 dumps 契约：HTTP 状态码是 success/failure 第一信号；非 2xx 不应进入 schema 解析，
  // 否则 401/403/500/rate-limit 会被误报为 "schema validation failed"。
  if (orderResponse.status < 200 || orderResponse.status >= 300) {
    throw new Error(`order/list HTTP ${orderResponse.status}`);
  }

  const parsedOrders = OrderListResponseSchema.safeParse(orderResponse.body);
  if (!parsedOrders.success) {
    throw new Error(`order/list response failed schema validation: ${parsedOrders.error.message}`);
  }

  // TikTok Seller Center 业务信封：HTTP 200 + code !== 0 表示业务失败（鉴权失效/限流/字段缺失等）。
  // schema 校验通过但 code 非 0 时必须报错，不能当成功数据继续走。
  if (parsedOrders.data.code !== 0) {
    throw new Error(`order/list business code ${parsedOrders.data.code}: ${parsedOrders.data.message}`);
  }

  const orders = parsedOrders.data.data.main_orders;
  const totalCount = Number(parsedOrders.data.data.total_count) || 0;
  const hasMore = parsedOrders.data.data.has_more ?? false;
  const nextCursor = parsedOrders.data.data.next_cursor_token ?? null;

  // Step 2: sequentially fetch logistics for each order
  const mainOrderIds = extractMainOrderIds(orderResponse.body);
  const logistics: OrderWithLogisticsResult['logistics'] = [];

  for (const mainOrderId of mainOrderIds) {
    const logisticUrl = tiktokOrderEndpointUrl(TIKTOK_API_ORIGIN, 'logistic-detail', identity, {
      main_order_id: mainOrderId,
    });
    try {
      const logisticResponse = await handlers.fetchJson(logisticUrl, {
        method: 'GET',
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      if (logisticResponse.status < 200 || logisticResponse.status >= 300) {
        logistics.push({
          mainOrderId,
          ok: false,
          error: `logistic_detail HTTP ${logisticResponse.status}`,
        });
        continue;
      }
      const parsed = LogisticDetailResponseSchema.safeParse(logisticResponse.body);
      if (parsed.success) {
        if (parsed.data.code !== 0) {
          logistics.push({
            mainOrderId,
            ok: false,
            error: `logistic_detail business code ${parsed.data.code}: ${parsed.data.message}`,
          });
        } else {
          logistics.push({ mainOrderId, ok: true, result: parsed.data });
        }
      } else {
        logistics.push({ mainOrderId, ok: false, error: `schema validation failed: ${parsed.error.message}` });
      }
    } catch (error) {
      logistics.push({
        mainOrderId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Step 3: build sku→product map from the same order response
  const skuToProductId = extractSkuToProductIdMap(orderResponse.body);

  return { orders, logistics, skuToProductId, totalCount, hasMore, nextCursor };
}
