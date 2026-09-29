/**
 * TikTok Seller Center settlement (pay/statement) endpoint contracts.
 *
 * Paths and request shapes are derived from the canonical reference:
 *   codex-tiktok-shop-order-product-logistics-api.md
 *
 * Pure builders — no chrome.* imports, no fetch calls.
 */

export const TIKTOK_STATEMENT_ENDPOINT_PATHS = {
  'statement-list': '/api/v1/pay/statement/list/detail',
  'statement-order-list': '/api/v1/pay/statement/order/list',
  'statement-transaction-detail': '/api/v1/pay/statement/transaction/detail',
} as const;

/** Canonical Seller Center API origin used by settlement requests. */
export const TIKTOK_STATEMENT_API_ORIGIN = 'https://api16-normal-sg.tiktokshopglobalselling.com';

export type TikTokStatementEndpointKind = keyof typeof TIKTOK_STATEMENT_ENDPOINT_PATHS;

// ─── URL builders ────────────────────────────────────────────────────

export function tiktokStatementEndpointUrl(
  origin: string,
  kind: TikTokStatementEndpointKind,
  identity?: { sellerId?: string; region?: string },
  extraQuery?: Record<string, string>,
): string {
  const base = `${origin}${TIKTOK_STATEMENT_ENDPOINT_PATHS[kind]}`;
  const params = new URLSearchParams();
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

// ─── Request builders ────────────────────────────────────────────────

/** Query params for statement/list/detail (GET — no body). Defaults match observed capture. */
export function createStatementListQuery(input: {
  from?: number;
  size?: number;
  pageType?: number;
  statementVersion?: number;
  needTotalAmount?: boolean;
  paginationType?: number;
}): Record<string, string> {
  const query: Record<string, string> = {
    pagination_type: String(input.paginationType ?? 1),
    from: String(input.from ?? 0),
    size: String(input.size ?? 10),
    page_type: String(input.pageType ?? 5),
    need_total_amount: String(input.needTotalAmount ?? false),
    statement_version: String(input.statementVersion ?? 0),
  };
  return query;
}

/**
 * Query params for the statement drill-down that exposes nested
 * sku_records[].statement_sku_detail_id values.
 */
export function createStatementOrderListQuery(input: {
  statementId: string;
  statementVersion: number;
  from?: number;
  size?: number;
  settlementStatus?: 1 | 2;
  pageType?: 6 | 10;
}): Record<string, string> {
  return {
    pagination_type: '1',
    from: String(input.from ?? 0),
    size: String(input.size ?? 50),
    terminal_type: '1',
    page_type: String(input.pageType ?? 6),
    statement_id: input.statementId,
    settlement_status: String(input.settlementStatus ?? 2),
    no_need_sku_record: 'false',
    need_total_amount: 'false',
    statement_version: String(input.statementVersion),
  };
}

/** Query params for statement/transaction/detail (GET — no body). */
export function createStatementTransactionDetailQuery(input: {
  statementSkuDetailId: string;
  statementVersion?: number;
  terminalType?: number;
  pageType?: number;
}): Record<string, string> {
  return {
    terminal_type: String(input.terminalType ?? 1),
    page_type: String(input.pageType ?? 9),
    statement_sku_detail_id: input.statementSkuDetailId,
    statement_version: String(input.statementVersion ?? 0),
  };
}
