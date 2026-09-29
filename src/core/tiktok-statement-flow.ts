/**
 * Pure-function flow for settlement (pay/statement) endpoints.
 *
 * No chrome.* imports. The caller injects a fetch handler.
 *
 * statement/list/detail does NOT return statement_sku_detail_id. Production
 * callers discover it through statement/order/list before calling
 * fetchStatementTransactionDetail.
 */

import {
  createStatementListQuery,
  createStatementTransactionDetailQuery,
  tiktokStatementEndpointUrl,
} from './tiktok-statement-endpoints';
import {
  StatementListResponseSchema,
  StatementTransactionDetailResponseSchema,
} from './tiktok-statement-endpoint-schemas';
import type {
  StatementRecord,
  StatementSkuRecord,
} from './tiktok-statement-endpoint-schemas';

// ─── Handler interface (injected) ────────────────────────────────────

export interface StatementFlowHandlers {
  fetchJson: (
    url: string,
    init?: { method?: string; body?: string; signal?: AbortSignal },
  ) => Promise<{ status: number; body: unknown }>;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface StatementFlowIdentity {
  sellerId: string;
  region: string;
}

export interface StatementListResult {
  statements: StatementRecord[];
  totalRecord: number;
  nextCursor: string | null;
  hasMore: boolean;
  previousCursor: string | null;
  previousHasMore: boolean;
}

export interface StatementDetailResult {
  ok: boolean;
  record?: StatementSkuRecord;
  sellerWebCutFlow?: boolean;
  sellerAppCutFlow?: boolean;
  error?: string;
}

// ─── Flow ────────────────────────────────────────────────────────────

/**
 * Fetch one page of statement/list/detail.
 *
 * Offset-based pagination (from/size). The response also carries
 * search_next_cursor / search_previous_cursor for cursor navigation,
 * but the caller controls which mechanism to use.
 */
export async function fetchStatementList(
  handlers: StatementFlowHandlers,
  origin: string,
  identity: StatementFlowIdentity,
  opts: {
    from?: number;
    size?: number;
    pageType?: number;
    statementVersion?: number;
    needTotalAmount?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<StatementListResult> {
  const query = createStatementListQuery({
    ...(opts.from === undefined ? {} : { from: opts.from }),
    ...(opts.size === undefined ? {} : { size: opts.size }),
    ...(opts.pageType === undefined ? {} : { pageType: opts.pageType }),
    ...(opts.statementVersion === undefined ? {} : { statementVersion: opts.statementVersion }),
    ...(opts.needTotalAmount === undefined ? {} : { needTotalAmount: opts.needTotalAmount }),
  });
  const url = tiktokStatementEndpointUrl(origin, 'statement-list', identity, query);
  const response = await handlers.fetchJson(url, {
    method: 'GET',
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  // §2.5 dumps 契约：HTTP 状态码是 success/failure 第一信号；非 2xx 不应进入 schema 解析，
  // 否则 401/403/500/rate-limit 会被误报为 "schema validation failed"。
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`statement/list/detail HTTP ${response.status}`);
  }

  const parsed = StatementListResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    throw new Error(`statement/list/detail response failed schema validation: ${parsed.error.message}`);
  }

  // TikTok 业务信封：HTTP 200 + code !== 0 表示业务失败（鉴权失效/限流/字段缺失等）。
  // 这种响应经常满足 schema（data 字段可能合法），但不能当正常数据继续走。
  if (parsed.data.code !== 0) {
    throw new Error(`statement/list/detail business code ${parsed.data.code}: ${parsed.data.message}`);
  }

  const data = parsed.data.data;
  return {
    statements: data.statement_records,
    totalRecord: Number(data.total_record) || 0,
    nextCursor: data.search_next_cursor ?? null,
    hasMore: data.search_next_has_more ?? false,
    previousCursor: data.search_previous_cursor ?? null,
    previousHasMore: data.search_previous_has_more ?? false,
  };
}

/**
 * Fetch a single SKU-level settlement detail.
 *
 * Requires statement_sku_detail_id — the caller must already have it.
 * Obtain the ID from statement/order/list sku_records before calling.
 */
export async function fetchStatementTransactionDetail(
  handlers: StatementFlowHandlers,
  origin: string,
  identity: StatementFlowIdentity,
  statementSkuDetailId: string,
  opts: {
    statementVersion?: number;
    terminalType?: number;
    pageType?: number;
    signal?: AbortSignal;
  } = {},
): Promise<StatementDetailResult> {
  const query = createStatementTransactionDetailQuery({
    statementSkuDetailId,
    ...(opts.statementVersion === undefined ? {} : { statementVersion: opts.statementVersion }),
    ...(opts.terminalType === undefined ? {} : { terminalType: opts.terminalType }),
    ...(opts.pageType === undefined ? {} : { pageType: opts.pageType }),
  });
  const url = tiktokStatementEndpointUrl(origin, 'statement-transaction-detail', identity, query);

  try {
    const response = await handlers.fetchJson(url, {
      method: 'GET',
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    // §2.5 dumps 契约：detail 路径同样要求先看 HTTP 状态码。
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, error: `statement/transaction/detail HTTP ${response.status}` };
    }
    const parsed = StatementTransactionDetailResponseSchema.safeParse(response.body);
    if (!parsed.success) {
      return { ok: false, error: `schema validation failed: ${parsed.error.message}` };
    }
    // TikTok 业务信封：HTTP 200 + code !== 0 也必须当失败（之前会被当成功返回，污染结算数据）。
    if (parsed.data.code !== 0) {
      return { ok: false, error: `statement/transaction/detail business code ${parsed.data.code}: ${parsed.data.message}` };
    }
    return {
      ok: true,
      record: parsed.data.data.sku_record,
      ...(parsed.data.seller_web_cut_flow === undefined ? {} : { sellerWebCutFlow: parsed.data.seller_web_cut_flow }),
      ...(parsed.data.seller_app_cut_flow === undefined ? {} : { sellerAppCutFlow: parsed.data.seller_app_cut_flow }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
