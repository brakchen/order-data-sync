import { z } from 'zod';

const AfterSalesLineItemSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
}).passthrough();

export const AfterSalesCancellationSchema = z.object({
  cancel_id: z.union([z.string(), z.number()]).optional(),
  order_id: z.union([z.string(), z.number()]).optional(),
  main_order_id: z.union([z.string(), z.number()]).optional(),
  cancel_line_items: z.array(AfterSalesLineItemSchema).optional(),
}).passthrough();

export const AfterSalesSearchResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.object({
    cancellations: z.array(AfterSalesCancellationSchema),
    search_next_has_more: z.boolean().optional(),
    has_more: z.boolean().optional(),
    search_next_cursor: z.string().optional(),
    next_page_token: z.string().optional(),
    total_count: z.union([z.number(), z.string()]).optional(),
  }).passthrough(),
}).passthrough();

export type AfterSalesSearchResponse = z.infer<typeof AfterSalesSearchResponseSchema>;
