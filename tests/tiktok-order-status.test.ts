import { describe, expect, it } from 'vitest';
import {
  isCancelledTikTokOrderRow,
  TIKTOK_CANCELLED_MAIN_ORDER_STATUS,
} from '../src/core/tiktok-order-status';

describe('TikTok order status', () => {
  it('defines 104 as the cancelled main-order status', () => {
    expect(TIKTOK_CANCELLED_MAIN_ORDER_STATUS).toBe(104);
    expect(isCancelledTikTokOrderRow({
      order_status_module: [{ main_order_status: 104 }],
    })).toBe(true);
  });

  it('keeps mixed-status and missing-status rows eligible for logistics', () => {
    expect(isCancelledTikTokOrderRow({
      order_status_module: [
        { main_order_status: 104 },
        { main_order_status: 101 },
      ],
    })).toBe(false);
    expect(isCancelledTikTokOrderRow({ main_order_id: 'missing-status' })).toBe(false);
  });
});
