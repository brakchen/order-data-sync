import { describe, expect, it } from 'vitest';
import {
  createAfterSalesSearchBody,
  TIKTOK_AFTER_SALES_ENDPOINT_PATH,
  tiktokAfterSalesEndpointUrl,
} from '../src/core/tiktok-after-sales-endpoints';
import { AfterSalesSearchResponseSchema } from '../src/core/tiktok-after-sales-endpoint-schemas';

describe('TikTok after-sales endpoint contract', () => {
  it('builds the Seller Center URL and paged request body', () => {
    const url = tiktokAfterSalesEndpointUrl(
      'https://api.example.test',
      { sellerId: 'seller-1', region: 'VN' },
    );
    expect(url).toContain(`${TIKTOK_AFTER_SALES_ENDPOINT_PATH}?`);
    expect(url).toContain('seller_id=seller-1');
    expect(createAfterSalesSearchBody({ offset: 50, count: 50, searchCursor: 'cursor-2' })).toEqual({
      count: 50,
      offset: 50,
      pagination_type: 0,
      search_condition: { condition_list: {} },
      search_cursor: 'cursor-2',
    });
  });

  it('accepts the cancellation response shape used by the ERP parser', () => {
    const result = AfterSalesSearchResponseSchema.safeParse({
      code: 0,
      message: 'success',
      data: {
        total_count: 1,
        search_next_has_more: false,
        cancellations: [{
          cancel_id: 'cancel-1',
          order_id: 'order-1',
          cancel_line_items: [{ id: 'line-1', quantity: 1 }],
        }],
      },
    });
    expect(result.success).toBe(true);
  });
});
