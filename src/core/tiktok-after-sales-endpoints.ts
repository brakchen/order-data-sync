/** TikTok Seller Center after-sales/cancellation endpoint contracts. */

export const TIKTOK_AFTER_SALES_ENDPOINT_PATH = '/return_refund/202309/cancellations/search';

/** The after-sales endpoint is served by the same Seller Center API origin. */
export const TIKTOK_AFTER_SALES_API_ORIGIN = 'https://api16-normal-sg.tiktokshopglobalselling.com';

export function tiktokAfterSalesEndpointUrl(
  origin: string,
  identity?: { sellerId?: string; region?: string },
): string {
  const params = new URLSearchParams({
    locale: 'zh-CN',
    language: 'zh-CN',
    aid: '6556',
    app_name: 'i18n_ecom_shop',
    device_platform: 'web',
    cookie_enabled: 'true',
  });
  if (identity?.sellerId) {
    params.set('oec_seller_id', identity.sellerId);
    params.set('seller_id', identity.sellerId);
  }
  return `${origin}${TIKTOK_AFTER_SALES_ENDPOINT_PATH}?${params.toString()}`;
}

/** Request body observed for Seller Center list endpoints. */
export function createAfterSalesSearchBody(input: {
  offset?: number;
  count?: number;
  searchCursor?: string;
}): Record<string, unknown> {
  return {
    count: input.count ?? 50,
    offset: input.offset ?? 0,
    pagination_type: 0,
    search_condition: { condition_list: {} },
    search_cursor: input.searchCursor ?? '',
  };
}
