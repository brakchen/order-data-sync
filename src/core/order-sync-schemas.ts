/**
 * Zod schemas for the order-sync protocol (tts-erp /v2/order-sync/*).
 *
 * These validate the wire shapes for:
 * - POST /v2/order-sync/has-data  (bulk coverage check)
 * - POST /v2/order-sync/dumps     (single dump upload)
 * - POST /v2/order-sync/reconcile (orders + logistics reconciliation state)
 *
 * Mirrors the analytics-sync-v2 dump architecture but for order/logistics/
 * statement domains.
 */

import { z } from 'zod';

// ─── has-data request / response ────────────────────────────────────

export const HasDataRequestSchema = z.object({
  scope: z.object({
    sellerId: z.string().min(1).max(128),
    shopId: z.string().min(1).max(128),
  }),
  domain: z.enum(['orders', 'logistics', 'statements', 'after_sales']),
  ids: z.array(z.string().min(1)).min(1).max(500),
  // 结算域的唯一键还包含 statement_version；缺省表示兼容旧客户端的 ID-only 语义。
  versions: z.record(
    z.string(),
    z.union([z.number().int(), z.array(z.number().int())]),
  ).optional(),
});

export type HasDataRequest = z.infer<typeof HasDataRequestSchema>;

export const HasDataResponseSchema = z.object({
  code: z.number(),
  requestId: z.string().optional(),
  data: z.object({
    domain: z.enum(['orders', 'logistics', 'statements', 'after_sales']),
    covered: z.record(z.string(), z.boolean()),
  }),
});

export type HasDataResponse = z.infer<typeof HasDataResponseSchema>;

// ─── dump upload request / response ─────────────────────────────────

export const OrderSyncDumpRequestSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().min(1).max(128).optional(),
  scope: z.object({
    sellerId: z.string().min(1).max(128),
    shopId: z.string().min(1).max(128),
  }),
  dump: z.object({
    domain: z.enum(['orders', 'logistics', 'statements', 'after_sales']),
    mainOrderId: z.string().max(128).optional(),
    statementId: z.string().max(128).optional(),
    statementVersion: z.number().int().optional(),
    endpoint: z.string().min(1).max(512),
    method: z.string().min(1).max(16),
    request: z.object({
      params: z.record(z.string(), z.unknown()).nullable().optional(),
      body: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
    response: z.object({
      status: z.number().int(),
      body: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
    // Backend parses this as an aware datetime; reject local/no-timezone
    // strings here so the request cannot pass client validation and fail at
    // the protocol boundary.
    createdAt: z.string().datetime({ offset: true }),
  }),
});

export type OrderSyncDumpRequest = z.infer<typeof OrderSyncDumpRequestSchema>;

/**
 * `/v2/order-sync/dumps` 成功响应 envelope。
 *
 * `data` 各字段全部可选 —— 服务端成功响应使用统一 envelope，硬契约只到
 * `code === 0`；缺字段不报错（理由见 `order-sync.ts::parseDumpResponse` 注释）。
 */
export const OrderSyncDumpResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  requestId: z.string().min(1).max(128).optional(),
  data: z
    .record(z.string(), z.unknown())
    .optional(),
});

export type OrderSyncDumpResponse = z.infer<typeof OrderSyncDumpResponseSchema>;

// ─── reconciliation request / response ─────────────────────────────

export const OrderSyncReconcileRequestSchema = z.object({
  protocolVersion: z.literal(1),
  scope: z.object({
    sellerId: z.string().min(1).max(128),
    shopId: z.string().min(1).max(128),
  }),
  domains: z.array(z.enum(['orders', 'logistics']))
    .min(1)
    .max(2)
    .refine((domains) => new Set(domains).size === domains.length, {
      message: 'domains must not contain duplicates',
    }),
  orders: z.object({
    pageSize: z.number().int().positive().max(500),
    sortInfo: z.string().min(1).max(32),
    anchorPositions: z.array(z.number().int().nonnegative()).max(16),
    hotWindowSize: z.number().int().nonnegative().max(500),
  }).optional(),
  logistics: z.object({
    limit: z.number().int().positive().max(500),
    cursor: z.string().regex(/^[0-9]+$/).max(128).nullable().optional(),
  }).optional(),
}).superRefine((request, context) => {
  if (request.domains.includes('orders') && !request.orders) {
    context.addIssue({ code: 'custom', path: ['orders'], message: 'orders block is required' });
  }
  if (request.domains.includes('logistics') && !request.logistics) {
    context.addIssue({ code: 'custom', path: ['logistics'], message: 'logistics block is required' });
  }
});

export type OrderSyncReconcileRequest = z.infer<typeof OrderSyncReconcileRequestSchema>;

const ReconcileAnchorSchema = z.object({
  position: z.number().int().nonnegative(),
  orderId: z.string().min(1),
});

const ReconcileOrderingSchema = z.object({
  field: z.string().min(1),
  direction: z.enum(['asc', 'desc']),
  tieBreaker: z.string().min(1),
});

const OrderReconcileStateSchema = z.object({
  serverTotal: z.number().int().nonnegative(),
  anchors: z.array(ReconcileAnchorSchema),
  canIncremental: z.boolean(),
  offsetSafe: z.boolean(),
  ordering: ReconcileOrderingSchema,
  hotWindowSize: z.number().int().nonnegative().max(500),
});

const LogisticsReconcileItemSchema = z.object({
  orderId: z.string().min(1),
  packageIds: z.array(z.string().min(1)).optional(),
  isTerminal: z.boolean(),
  terminalReason: z.string().min(1).nullable().optional(),
  nextCheckAt: z.string().min(1).nullable().optional(),
});

const LogisticsReconcileStateSchema = z.object({
  complete: z.boolean(),
  items: z.array(LogisticsReconcileItemSchema),
  nextCursor: z.string().regex(/^[0-9]+$/).max(128).nullable().optional(),
  pendingTotal: z.number().int().nonnegative().optional(),
  terminalTotal: z.number().int().nonnegative().optional(),
});

export const OrderSyncReconcileResponseSchema = z.object({
  code: z.number(),
  requestId: z.string().min(1).max(128).optional(),
  data: z.object({
    orders: OrderReconcileStateSchema.optional(),
    logistics: LogisticsReconcileStateSchema.optional(),
  }),
});

export type OrderSyncReconcileResponse = z.infer<typeof OrderSyncReconcileResponseSchema>;

// ─── Domain enum ────────────────────────────────────────────────────

export const ORDER_SYNC_DOMAINS = ['orders', 'logistics', 'statements', 'after_sales'] as const;
export type OrderSyncDomain = (typeof ORDER_SYNC_DOMAINS)[number];
