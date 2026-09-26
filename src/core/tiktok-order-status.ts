/** TikTok Seller Center order status values used by sync consumers. */

/** main_order_status=104 is the observed CANCELLED order state. */
export const TIKTOK_CANCELLED_MAIN_ORDER_STATUS = 104;

/**
 * Return true only when every order-line status in the raw order row is 104.
 * Mixed-status orders must remain eligible for logistics because another line
 * may still have an active package.
 */
export function isCancelledTikTokOrderRow(row: Record<string, unknown>): boolean {
  const statusModule = row.order_status_module;
  if (!Array.isArray(statusModule) || statusModule.length === 0) return false;
  return statusModule.every((entry) => (
    typeof entry === 'object'
    && entry !== null
    && (entry as { main_order_status?: unknown }).main_order_status === TIKTOK_CANCELLED_MAIN_ORDER_STATUS
  ));
}
