import type { OrderDomainKey, OrderSyncSettings } from '../core/types';

export type OrderExtensionMessage =
  | { type: 'order-sync:get-state' }
  | { type: 'order-sync:save-settings'; settings: OrderSyncSettings }
  | { type: 'order-sync:bind-tab' }
  | { type: 'order-sync:unbind-tab' }
  | { type: 'order-sync:sync-domains'; retryFailedOnly?: boolean }
  | { type: 'order-sync:stop-stuck-domain'; domain: OrderDomainKey }
  | { type: 'order-sync:capture-seller'; payload: { sellerId: string; url: string; advertiserId?: string } };

export const ORDER_EXTENSION_MESSAGE_TYPES = [
  'order-sync:get-state',
  'order-sync:save-settings',
  'order-sync:bind-tab',
  'order-sync:unbind-tab',
  'order-sync:capture-seller',
] as const;
