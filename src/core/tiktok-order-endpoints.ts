/**
 * TikTok Seller Center order + logistics endpoint contracts.
 *
 * Paths and request shapes are derived from the canonical reference:
 *   codex-tiktok-shop-order-product-logistics-api.md
 *
 * These are pure builders — no chrome.* imports, no fetch calls.
 * The caller injects a fetch implementation (typically the bound-page
 * MAIN-world fetch via chrome.scripting.executeScript).
 */

export const TIKTOK_ORDER_ENDPOINT_PATHS = {
  'order-list': '/api/fulfillment/order/list',
  'logistic-detail': '/api/v1/fulfillment/logistic_detail/list',
} as const;

export type TikTokOrderEndpointKind = keyof typeof TIKTOK_ORDER_ENDPOINT_PATHS;

// ─── URL builders ────────────────────────────────────────────────────

/**
 * Compose the full URL for an order-domain endpoint.
 * Identity fields go into query params exactly as the Seller Center sends them.
 */
export function tiktokOrderEndpointUrl(
  origin: string,
  kind: TikTokOrderEndpointKind,
  identity?: { sellerId?: string; region?: string },
  extraQuery?: Record<string, string>,
): string {
  const base = `${origin}${TIKTOK_ORDER_ENDPOINT_PATHS[kind]}`;
  const params = new URLSearchParams();
  // Standard Seller Center query params (observed in every captured request).
  params.set('locale', 'zh-CN');
  params.set('language', 'zh-CN');
  params.set('aid', '6556');
  params.set('app_name', 'i18n_ecom_shop');
  params.set('device_platform', 'web');
  params.set('cookie_enabled', 'true');
  if (identity?.sellerId) {
    params.set('oec_seller_id', identity.sellerId);
    params.set('seller_id', identity.sellerId);
  }
  if (extraQuery) {
    for (const [key, value] of Object.entries(extraQuery)) {
      params.set(key, value);
    }
  }
  return `${base}?${params.toString()}`;
}

// ─── Request body builders ───────────────────────────────────────────

/** POST body for order/list. Defaults match the observed page capture. */
export function createOrderListRequestBody(input: {
  offset?: number;
  count?: number;
  sortInfo?: string;
  searchCursor?: string;
  paginationType?: number;
  conditionList?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    search_condition: { condition_list: input.conditionList ?? {} },
    offset: input.offset ?? 0,
    count: input.count ?? 20,
    sort_info: input.sortInfo ?? '6',
    search_cursor: input.searchCursor ?? '',
    pagination_type: input.paginationType ?? 0,
  };
}

/** Query params for logistic_detail/list (GET — no body). */
export function createLogisticDetailQuery(mainOrderId: string): Record<string, string> {
  return { main_order_id: mainOrderId };
}
