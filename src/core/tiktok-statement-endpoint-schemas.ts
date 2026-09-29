/**
 * Zod schemas for statement/list/detail and statement/transaction/detail.
 * Mirrors the canonical contract in codex-tiktok-shop-order-product-logistics-api.md.
 */

import { z } from 'zod';

// ─── Shared amount shape ─────────────────────────────────────────────

/**
 * TikTok money object: amount is a string (may be negative), currency is
 * the ISO code, symbol/format fields are for display. We preserve all
 * fields via passthrough but only validate the ones we read.
 */
export const TikTokMoneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
}).passthrough();

export type TikTokMoney = z.infer<typeof TikTokMoneySchema>;

// ─── Statement list ──────────────────────────────────────────────────

/** A single statement record (one settlement period aggregate). */
export const StatementRecordSchema = z.object({
  statement_id: z.string().min(1),
  statement_version: z.number().int(),
  bill_period: z.string().optional(),
  settle_amount: TikTokMoneySchema.optional(),
  earning_amount: TikTokMoneySchema.optional(),
  fee_amount: TikTokMoneySchema.optional(),
  adjust_amount: TikTokMoneySchema.optional(),
  payment_id: z.string().optional(),
  payment_status: z.number().int().optional(),
  settlement_time: z.string().optional(),
  settlement_id: z.string().optional(),
  total_reserve_amount: TikTokMoneySchema.optional(),
  shipping_amount: TikTokMoneySchema.optional(),
  statement_type: z.number().int().optional(),
  payable_amount: TikTokMoneySchema.optional(),
  payment_pending_reason: z.number().int().optional(),
  // Some Seller Center deployments include the bridge ID on the list row;
  // when present the background can fetch transaction/detail directly.
  statement_sku_detail_id: z.string().min(1).optional(),
}).passthrough();

export type StatementRecord = z.infer<typeof StatementRecordSchema>;

export const StatementListResponseSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.object({
    search_next_cursor: z.string().optional(),
    search_next_has_more: z.boolean().optional(),
    search_previous_cursor: z.string().optional(),
    search_previous_has_more: z.boolean().optional(),
    total_record: z.union([z.number(), z.string()]).optional(),
    statement_records: z.array(StatementRecordSchema),
  }).passthrough(),
}).passthrough();

export type StatementListResponse = z.infer<typeof StatementListResponseSchema>;

// ─── Statement order/SKU bridge list ─────────────────────────────────

export const StatementOrderSkuRecordSchema = z.object({
  statement_sku_detail_id: z.string().min(1),
  statement_id: z.string().min(1).optional(),
  statement_version: z.number().int().optional(),
  sku_id: z.union([z.string(), z.number()]).optional(),
}).passthrough();

export const StatementOrderRecordSchema = z.object({
  statement_id: z.string().min(1).optional(),
  statement_version: z.number().int().optional(),
  trade_order_id: z.string().optional(),
  sku_records: z.array(StatementOrderSkuRecordSchema).optional().default([]),
}).passthrough();

export const StatementOrderListResponseSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.object({
    search_next_cursor: z.string().optional(),
    search_next_has_more: z.boolean().optional(),
    total_record: z.union([z.number(), z.string()]).optional(),
    order_records: z.array(StatementOrderRecordSchema),
  }).passthrough(),
}).passthrough();

export type StatementOrderListResponse = z.infer<typeof StatementOrderListResponseSchema>;
export type StatementSkuDetailRef = {
  statementSkuDetailId: string;
  statementId: string;
  statementVersion: number;
};

/** Extract and de-duplicate SKU detail IDs from a validated statement drill-down page. */
export function extractStatementSkuDetailRefs(
  response: StatementOrderListResponse,
  expected: { statementId: string; statementVersion: number },
): StatementSkuDetailRef[] {
  const refs = new Map<string, StatementSkuDetailRef>();
  for (const order of response.data.order_records) {
    for (const sku of order.sku_records) {
      const statementId = sku.statement_id ?? order.statement_id ?? expected.statementId;
      const statementVersion = sku.statement_version ?? order.statement_version ?? expected.statementVersion;
      if (statementId !== expected.statementId || statementVersion !== expected.statementVersion) {
        throw new Error(
          `statement/order/list identity mismatch: expected ${expected.statementId}@${expected.statementVersion}, `
          + `received ${statementId}@${statementVersion}`,
        );
      }
      refs.set(sku.statement_sku_detail_id, {
        statementSkuDetailId: sku.statement_sku_detail_id,
        statementId,
        statementVersion,
      });
    }
  }
  return [...refs.values()];
}

// ─── Statement transaction detail ────────────────────────────────────

/**
 * Recursive fee item. TikTok nests sub_fees up to at least 3 levels deep
 * (observed: seller_shipping_fee → customer_shipping_fee → 3 discount items).
 * We validate the first level strictly and let sub_fees be opaque arrays.
 */
const FeeItemBase = z.object({
  type: z.string(),
  starling: z.object({
    starling_key: z.string().optional(),
    starling_text: z.string().optional(),
  }).passthrough().optional(),
  amount: TikTokMoneySchema.optional(),
  fee_id: z.number().int().optional(),
  statement_item_id: z.number().int().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  title_configs: z.array(z.object({
    level: z.number().int().optional(),
    name: z.object({
      ruleKey: z.string().optional(),
      default: z.string().optional(),
      starlingKey: z.string().optional(),
    }).passthrough().optional(),
    tooltip: z.object({
      ruleKey: z.string().optional(),
      default: z.string().optional(),
      starlingKey: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough()).optional(),
});

export type FeeItem = z.infer<typeof FeeItemBase> & {
  sub_fees?: FeeItem[];
};

export const FeeItemSchema: z.ZodType<FeeItem> = FeeItemBase.extend({
  sub_fees: z.lazy(() => z.array(FeeItemSchema)).optional(),
}) as z.ZodType<FeeItem>;

/** The single SKU-level settlement record returned by transaction/detail. */
export const StatementSkuRecordSchema = z.object({
  statement_sku_detail_id: z.string().min(1),
  statement_id: z.string().min(1),
  statement_version: z.number().int(),
  sku_id: z.union([z.string(), z.number()]),
  trade_order_id: z.string().optional(),
  product_name: z.string().optional(),
  sku_name: z.string().optional(),
  quantity: z.number().int().optional(),
  settlement_amount: TikTokMoneySchema.optional(),
  earning_amount: TikTokMoneySchema.optional(),
  fees: TikTokMoneySchema.optional(),
  in_come: z.object({
    fee_list: z.array(FeeItemSchema).optional(),
    amount: TikTokMoneySchema.optional(),
  }).passthrough().optional(),
  out_come: z.object({
    fee_list: z.array(FeeItemSchema).optional(),
    amount: TikTokMoneySchema.optional(),
  }).passthrough().optional(),
  bill_period: z.string().optional(),
  settlement_status: z.number().int().optional(),
  placed_time: z.string().optional(),
}).passthrough();

export type StatementSkuRecord = z.infer<typeof StatementSkuRecordSchema>;

/**
 * Transaction detail response. Note: seller_web_cut_flow and
 * seller_app_cut_flow sit at the ROOT level (sibling to data), NOT inside it.
 */
export const StatementTransactionDetailResponseSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.object({
    sku_record: StatementSkuRecordSchema,
  }).passthrough(),
  seller_web_cut_flow: z.boolean().optional(),
  seller_app_cut_flow: z.boolean().optional(),
}).passthrough();

export type StatementTransactionDetailResponse = z.infer<typeof StatementTransactionDetailResponseSchema>;

// ─── Extractors ──────────────────────────────────────────────────────

/** Pull statement_id + statement_version from every row in a validated list response. */
export function extractStatementIds(response: unknown): Array<{ statementId: string; statementVersion: number }> {
  const parsed = StatementListResponseSchema.safeParse(response);
  if (!parsed.success) {
    // §2.5 dumps 契约：原实现吞 Zod 失败返 [] 让 "parse error" 看起来像 "no more data"，
    // 调用方按 0 行继续同步会静默丢结算记录。改为抛错强制调用方显式处理
    // （PERMANENT / PROTOCOL 分类）。调用方必须 try/catch 并决定是否上传空 dump。
    throw new Error(`extractStatementIds: schema/parse failed: ${parsed.error.message}`);
  }
  return parsed.data.data.statement_records.map((row) => ({
    statementId: row.statement_id,
    statementVersion: row.statement_version,
  }));
}

/**
 * Extract statement_sku_detail_id from a validated detail response.
 * The detail endpoint returns exactly one record; we echo back the ID.
 */
export function extractStatementSkuDetailId(response: unknown): string | null {
  const parsed = StatementTransactionDetailResponseSchema.safeParse(response);
  if (!parsed.success) return null;
  return parsed.data.data.sku_record.statement_sku_detail_id;
}
