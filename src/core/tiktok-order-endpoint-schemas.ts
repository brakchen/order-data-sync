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

// ─── Order get (order detail) ────────────────────────────────────────

/** A single price/money object. */
const MoneySchema = z.object({
  format_price: z.string(),
  price_val: z.string(),
  currency: z.string(),
  symbol: z.string(),
}).passthrough();

/** A single order-get row (full order detail). */
export const OrderGetRowSchema = z.object({
  main_order_id: z.string().min(1),
  trade_order_module: z.object({
    main_order_id: z.string(),
    create_time: z.string(),
    payment_time: z.string().optional(),
    pay_method: z.string().optional(),
    update_time: z.string().optional(),
    platform: z.number().int().optional(),
    business_line: z.number().int().optional(),
    sale_region: z.string().optional(),
    main_order_type: z.number().int().optional(),
    fulfillment_type: z.number().int().optional(),
    latest_rts_time: z.string().optional(),
    latest_tts_time: z.string().optional(),
    close_sla_time: z.string().optional(),
    need_invoice_flag: z.boolean().optional(),
    shipping_fee: MoneySchema.optional(),
  }).passthrough().optional(),
  order_status_module: z.array(z.object({
    order_line_id: z.string(),
    main_order_status: z.number().int(),
    main_sub_order_status: z.number().int(),
    sku_display_status: z.number().int().optional(),
  }).passthrough()).optional(),
  sku_module: z.array(z.object({
    sku_id: z.union([z.string(), z.number()]),
    product_id: z.union([z.string(), z.number()]).optional(),
    product_name: z.string().optional(),
    sku_name: z.string().optional(),
    quantity: z.number().int().optional(),
    sku_unit_price: MoneySchema.optional(),
    sku_total_price: MoneySchema.optional(),
  }).passthrough()).optional(),
  fulfillment_module: z.array(z.object({
    fulfill_unit_id: z.string(),
    fulfillment_status_v2: z.number().int().optional(),
    ship_exception_code: z.number().int().optional(),
    rts_time: z.string().optional(),
    print_time: z.string().optional(),
    create_time: z.string().optional(),
    update_time: z.string().optional(),
    total_order_count: z.number().int().optional(),
    total_item_count: z.number().int().optional(),
  }).passthrough()).optional(),
  delivery_module: z.array(z.object({
    fulfill_unit_id: z.string(),
    tracking_no: z.string().optional(),
    warehouse_region: z.string().optional(),
    buyer_region: z.string().optional(),
    warehouse_id: z.string().optional(),
    warehouse_name: z.string().optional(),
    last_tracking_no: z.string().optional(),
    shipment_provider_info: z.object({
      id: z.string().optional(),
      name: z.string().optional(),
    }).passthrough().optional(),
    logistics_service_info: z.object({
      logistics_service_id: z.string().optional(),
      logistics_service_name: z.string().optional(),
      logistics_service_level: z.string().optional(),
    }).passthrough().optional(),
    pickup_type: z.number().int().optional(),
    payment_total: MoneySchema.optional(),
  }).passthrough()).optional(),
  price_module: z.object({
    main_order_id: z.string(),
    sub_total: MoneySchema.optional(),
    grand_total: MoneySchema.optional(),
    shipping_fee: MoneySchema.optional(),
    platform_discount_total: MoneySchema.optional(),
    seller_discount_total: MoneySchema.optional(),
    main_order_origin_sale_price: MoneySchema.optional(),
    shipping_origin_fee: MoneySchema.optional(),
    shipping_fee_discount_seller: MoneySchema.optional(),
    shipping_fee_discount_platform: MoneySchema.optional(),
    promotion_infos: z.array(z.object({
      promotion_name: z.string().optional(),
      promotion_cost: z.string().optional(),
      promotion_type: z.number().int().optional(),
    }).passthrough()).optional(),
  }).passthrough().optional(),
  reverse_module: z.array(z.object({
    reverse_order_id: z.string().optional(),
    order_line_ids: z.array(z.string()).optional(),
    reverse_status: z.number().int().optional(),
    reverse_type: z.number().int().optional(),
    reverse_tab_status: z.number().int().optional(),
    reverse_reason: z.string().optional(),
    reverse_from: z.number().int().optional(),
    cancelled_time: z.string().optional(),
  }).passthrough()).optional(),
  buyer_info_module: z.object({
    shipping_address: z.object({
      id: z.string().optional(),
      items: z.array(z.object({
        key: z.string(),
        value: z.string(),
      }).passthrough()).optional(),
      region: z.object({
        name: z.string().optional(),
        code: z.string().optional(),
      }).passthrough().optional(),
      districts: z.array(z.object({
        name: z.string().optional(),
        district_key: z.string().optional(),
      }).passthrough()).optional(),
      address_id: z.string().optional(),
      address_type: z.number().int().optional(),
    }).passthrough().optional(),
    buyer_nickname: z.string().optional(),
  }).passthrough().optional(),
  logistics_info_module: z.array(z.object({
    fulfill_unit_id: z.string(),
    logistics_detail_item: z.object({
      timestamp: z.number().optional(),
      display_msg: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough()).optional(),
  fulfill_line_module: z.array(z.object({
    sku_id: z.union([z.string(), z.number()]),
    product_id: z.union([z.string(), z.number()]).optional(),
    product_name: z.string().optional(),
    sku_name: z.string().optional(),
    quantity: z.number().int().optional(),
    sku_unit_price: MoneySchema.optional(),
    sku_total_price: MoneySchema.optional(),
  }).passthrough()).optional(),
}).passthrough();

export type OrderGetRow = z.infer<typeof OrderGetRowSchema>;

export const OrderGetResponseSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.object({
    main_order: z.array(OrderGetRowSchema),
  }).passthrough(),
}).passthrough();

export type OrderGetResponse = z.infer<typeof OrderGetResponseSchema>;

// ─── Order history ───────────────────────────────────────────────────

export const OrderHistoryItemSchema = z.object({
  description: z.string(),
  trans_time: z.string(),
  timestamp: z.number().int(),
  detail: z.string().optional(),
  elements: z.array(z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    media_items: z.array(z.object({
      picture: z.object({
        height: z.number().int().optional(),
        width: z.number().int().optional(),
        uri: z.string().optional(),
        url_list: z.array(z.string()).optional(),
      }).passthrough().optional(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

export type OrderHistoryItem = z.infer<typeof OrderHistoryItemSchema>;

export const OrderHistoryResponseSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.object({
    total_count: z.number().int(),
    order_history: z.array(OrderHistoryItemSchema),
  }).passthrough(),
}).passthrough();

export type OrderHistoryResponse = z.infer<typeof OrderHistoryResponseSchema>;

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
