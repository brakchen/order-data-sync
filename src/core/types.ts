/** Domain-owned state for the standalone order extension. */
export type OrderDomainKey = 'orders' | 'logistics' | 'statements' | 'order_details' | 'order_history';
/** Domains that can be shown in the popup, including the protocol-ready after-sales domain. */
export type OrderDisplayDomainKey = OrderDomainKey | 'after_sales';
export type OrderSyncTrigger = 'automatic' | 'manual';
export type OrderDomainRunStatus = 'idle' | 'running' | 'done' | 'partial_failed' | 'interrupted';
export type OrderDomainListPhase = 'idle' | 'list_fetching' | 'processing';
export type OrderSyncStrategy = 'full' | 'incremental' | 'fallback' | 'repair';
export type OrderReconcileStatus = 'passed' | 'failed' | 'unavailable' | null;

export interface OrderListCheckpoint {
  total: number;
  headOrderId: string | null;
  middleOrderId: string | null;
  tailOrderId: string | null;
  orderingDirection: 'asc' | 'desc';
  windowKey: string;
  auditOffset: number;
  lastExactAuditAt: string | null;
  statusRefreshVersion?: number;
  capturedAt: string;
}

export interface OrderDomainProgressRow {
  total: number;
  covered: number;
  uploaded: number;
  pending: number;
  failed?: number;
  currentOrderId?: string | null;
  currentOrderIndex?: number | null;
  resumeOrderId?: string | null;
  failedOrderIds?: string[];
  snapshotKeys?: string[];
  pendingOrderIds?: string[];
  lastFailedOrderId?: string | null;
  listPhase?: OrderDomainListPhase;
  listPage?: number | null;
  listPageCount?: number | null;
  listRowsFetched?: number;
  listTotalRows?: number | null;
  listOffset?: number | null;
  listSearchCursor?: string | null;
  listPaginationType?: number | null;
  serverTotal?: number | null;
  syncStrategy?: OrderSyncStrategy;
  reconcileStatus?: OrderReconcileStatus;
  lastReconciledAt?: string | null;
  terminalSkipped?: number;
  auditOffset?: number | null;
  orderListCheckpoint?: OrderListCheckpoint | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  syncRunId?: string | null;
  syncTrigger?: OrderSyncTrigger | null;
  syncRunStatus?: OrderDomainRunStatus;
  lastProgressAt?: string | null;
  nextSyncAt?: string | null;
}

export interface OrderDomainProgress {
  status: 'idle' | 'running' | 'ok' | 'partial';
  lastRunAt: string | null;
  domains: Record<OrderDomainKey, OrderDomainProgressRow> & {
    after_sales: OrderDomainProgressRow;
  };
}

/** Credentials and pause controls belong only to this extension. */
export interface OrderSyncSettings {
  syncBaseUrl: string;
  syncToken: string;
  syncPaused: boolean;
  orderDomainSyncEnabled: boolean;
}

export interface OrderBoundTab {
  tabId: number;
  url: string;
  sellerId?: string;
  advertiserId?: string;
  shopName?: string;
  shopCode?: string;
  shopRegion?: string;
  sellerRegionCode?: string;
  bindMode?: 'auto' | 'manual';
  boundAt?: string;
}

export type SellerBindingMode = 'idle' | 'auto' | 'manual';
export type SellerBindingOutcome = 'none' | 'bound' | 'timeout' | 'failed';

export interface SellerBindingState {
  mode: SellerBindingMode;
  outcome: SellerBindingOutcome;
  deadlineAt: string | null;
}

export interface OrderShopRegion {
  sellerId: string;
  baseUrl: string;
  region: string;
  source?: 'server' | 'manual';
}

export interface OrderRuntimeLog {
  id: string;
  occurredAt: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  context: Record<string, unknown>;
}

export interface OrderSyncState {
  settings: OrderSyncSettings;
  boundTab: OrderBoundTab | null;
  sellerBinding: SellerBindingState;
  shopRegion: OrderShopRegion | null;
  orderProgress: OrderDomainProgress;
  runtimeLogs: OrderRuntimeLog[];
  createdAt: string;
  updatedAt: string;
}
