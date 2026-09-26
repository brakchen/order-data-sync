/**
 * SKU → product_id resolution.
 *
 * Builds a lookup map from order/list response rows (which carry both
 * sku_id and product_id in sku_module[] and fulfill_line_module[]).
 * Downstream consumers (e.g. statement detail) use this to resolve
 * product_id from a bare sku_id.
 *
 * Pure functions — no chrome.* imports.
 */

import type { OrderListRow } from './tiktok-order-endpoint-schemas';

/**
 * Build a sku_id → product_id map from order-list rows.
 * Reads both sku_module[] and fulfill_line_module[]; first occurrence wins.
 */
export function buildSkuToProductIdMap(rows: readonly OrderListRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    for (const mod of [row.sku_module, row.fulfill_line_module]) {
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

/** Look up product_id by sku_id. Returns undefined when not found. */
export function resolveProductId(
  skuId: string,
  skuToProductId: ReadonlyMap<string, string>,
): string | undefined {
  return skuToProductId.get(skuId);
}

/**
 * Merge a new map into an existing one without overwriting existing keys.
 * Useful when incrementally building the map across multiple order-list pages.
 */
export function mergeSkuToProductIdMap(
  target: Map<string, string>,
  source: ReadonlyMap<string, string>,
): Map<string, string> {
  for (const [skuId, productId] of source) {
    if (!target.has(skuId)) {
      target.set(skuId, productId);
    }
  }
  return target;
}
