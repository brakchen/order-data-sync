/** Seller Center identity endpoint contracts. */

export const TIKTOK_SELLER_IDENTITY_API_ORIGIN = 'https://api16-normal-sg.tiktokshopglobalselling.com';
export const TIKTOK_SELLER_IDENTITY_ENDPOINT_PATH = '/api/v3/seller/common/get';

export interface SellerIdentityResponseData {
  sellerId: string;
  shopName?: string;
  shopCode?: string;
  shopRegion?: string;
  regionCode?: string;
}

export function tiktokSellerIdentityEndpointUrl(
  origin = TIKTOK_SELLER_IDENTITY_API_ORIGIN,
  sellerId?: string,
): string {
  const url = new URL(TIKTOK_SELLER_IDENTITY_ENDPOINT_PATH, origin);
  const params = url.searchParams;
  params.set('locale', 'zh-CN');
  params.set('language', 'zh-CN');
  params.set('aid', '6556');
  params.set('app_name', 'i18n_ecom_shop');
  params.set('device_platform', 'web');
  params.set('cookie_enabled', 'true');
  params.set('version', '3');
  params.set('need_verify_account', 'true');
  params.set('only_get_seller', '1');
  // Match the identity hint used by Seller Center when a replacement tab is
  // checked. The response is still parsed and verified before it is trusted.
  if (sellerId?.trim()) {
    params.set('oec_seller_id', sellerId.trim());
    params.set('seller_id', sellerId.trim());
  }
  return url.toString();
}

export function parseSellerIdentityResponse(value: unknown): SellerIdentityResponseData | null {
  if (!isRecord(value) || value.code !== 0 || !isRecord(value.data) || !isRecord(value.data.seller)) return null;
  const seller = value.data.seller;
  if (typeof seller.seller_id !== 'string' || !seller.seller_id.trim()) return null;
  return {
    sellerId: seller.seller_id.trim(),
    ...(typeof seller.shop_name === 'string' && seller.shop_name ? { shopName: seller.shop_name } : {}),
    ...(typeof seller.shop_code === 'string' && seller.shop_code ? { shopCode: seller.shop_code } : {}),
    ...(typeof seller.shop_region === 'string' && seller.shop_region ? { shopRegion: seller.shop_region } : {}),
    ...(typeof seller.region_code === 'string' && seller.region_code ? { regionCode: seller.region_code } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
