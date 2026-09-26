/**
 * Zod schemas for order/list and logistic_detail/list responses.
 * Mirrors the canonical contract in codex-tiktok-shop-order-product-logistics-api.md.
 * Rows are opaque (.passthrough()) — we only validate the envelope and the
 * fields we extract for downstream linkage.
 */

import { z } from 'zod';

// ─── Order list ──────────────────────────────────────────────────────

export const OrderListRequestBodySchema = z.object({
  search_condition: z.object({
    condition_list: z.record(z.string(), z.unknown()),
  }),
  offset: z.number().int().min(0),
  count: z.number().int().positive(),
  sort_info: z.string(),
  search_cursor: z.string(),
  pagination_type: z.number().int(),
}).strict();

export type OrderListRequestBody = z.infer<typeof OrderListRequestBodySchema>;

/** A single main-order row. We only extract main_order_id and sku_module. */
export const OrderListRowSchema = z.object({
  main_order_id: z.string().min(1),
  sku_module: z.array(z.object({
    sku_id: z.union([z.string(), z.number()]),
    product_id: z.union([z.string(), z.number()]),
  }).passthrough()).optional(),
  fulfill_line_module: z.array(z.object({
    sku_id: z.union([z.string(), z.number()]),
    product_id: z.union([z.string(), z.number()]),
  }).passthrough()).optional(),
}).passthrough();

export type OrderListRow = z.infer<typeof OrderListRowSchema>;

export const OrderListResponseSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.object({
    offset: z.number().int().min(0),
    // 空末页合法返回 count: 0（与 offset min(0) 对齐；positive() 与之矛盾会让空响应
    // schema 校验失败，调用方按 parse error 处理就会静默丢订单）。
    count: z.number().int().min(0),
    total_count: z.union([z.number(), z.string()]),
    main_orders: z.array(OrderListRowSchema),
    next_cursor_token: z.string().optional(),
    has_more: z.boolean().optional(),
  }).passthrough(),
}).passthrough();

export type OrderListResponse = z.infer<typeof OrderListResponseSchema>;

// ─── Logistic detail ─────────────────────────────────────────────────

export const LogisticDetailPackageSchema = z.object({
  main_order_id: z.string().min(1),
  package_id: z.union([z.string(), z.number()]),
  tracking_no: z.string().optional(),
  logistic_supplier: z.string().optional(),
  logistic_detail: z.object({
    track_list: z.array(z.object({
      time: z.union([z.string(), z.number()]).optional(),
      track_status: z.string().optional(),
    }).passthrough()).optional(),
  }).passthrough().optional(),
}).passthrough();

export type LogisticDetailPackage = z.infer<typeof LogisticDetailPackageSchema>;

export const LogisticDetailResponseSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.object({
    package_list: z.array(LogisticDetailPackageSchema),
  }).passthrough(),
}).passthrough();

export type LogisticDetailResponse = z.infer<typeof LogisticDetailResponseSchema>;

// ─── Extractors ──────────────────────────────────────────────────────

/** Pull main_order_id from every row in a validated order-list response. */
export function extractMainOrderIds(response: unknown): string[] {
  const parsed = OrderListResponseSchema.safeParse(response);
  if (!parsed.success) return [];
  return parsed.data.data.main_orders.map((row) => row.main_order_id);
}

/**
 * Build a sku_id → product_id map from order-list rows.
 * Reads both sku_module[] and fulfill_line_module[] (either may carry the pair).
 */
export function extractSkuToProductIdMap(response: unknown): Map<string, string> {
  const parsed = OrderListResponseSchema.safeParse(response);
  if (!parsed.success) return new Map();
  const map = new Map<string, string>();
  for (const row of parsed.data.data.main_orders) {
    const modules = [row.sku_module, row.fulfill_line_module];
    for (const mod of modules) {
      if (!mod) continue;
      for (const item of mod) {
        const skuId = String(item.sku_id);
        const productId = String(item.product_id);
        if (skuId && productId && !map.has(skuId)) {
          map.set(skuId, productId);
        }
      }
    }
  }
  return map;
}
