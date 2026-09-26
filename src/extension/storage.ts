import { ORDER_RUNTIME_LOG_LIMIT, ORDER_SYNC_STATE_KEY, createDefaultOrderSettings, normalizeOrderSyncSettings } from '../core/settings';
import type { OrderBoundTab, OrderDomainKey, OrderDomainProgress, OrderDomainProgressRow, OrderListCheckpoint, OrderRuntimeLog, OrderSyncState } from '../core/types';

export function createDefaultOrderProgress(): OrderDomainProgress {
  const row = (): OrderDomainProgressRow => ({
    total: 0,
    covered: 0,
    uploaded: 0,
    pending: 0,
    failed: 0,
    currentOrderId: null,
    currentOrderIndex: null,
    resumeOrderId: null,
    failedOrderIds: [],
    snapshotKeys: [],
    pendingOrderIds: [],
    lastFailedOrderId: null,
    listPhase: 'idle',
    listPage: null,
    listPageCount: null,
    listRowsFetched: 0,
    listTotalRows: null,
    listOffset: null,
    listSearchCursor: null,
    listPaginationType: null,
    serverTotal: null,
    syncStrategy: 'full',
    reconcileStatus: null,
    lastReconciledAt: null,
    terminalSkipped: 0,
    auditOffset: null,
    orderListCheckpoint: null,
    lastSuccessAt: null,
    lastError: null,
    syncRunId: null,
    syncTrigger: null,
    syncRunStatus: 'idle',
    lastProgressAt: null,
    nextSyncAt: null,
  });
  return {
    status: 'idle',
    lastRunAt: null,
    domains: { orders: row(), logistics: row(), statements: row() },
  };
}

export function createDefaultOrderSyncState(now = new Date().toISOString()): OrderSyncState {
  return {
    settings: createDefaultOrderSettings(),
    boundTab: null,
    shopRegion: null,
    orderProgress: createDefaultOrderProgress(),
    runtimeLogs: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function getOrderSyncState(): Promise<OrderSyncState> {
  const stored = await chrome.storage.local.get(ORDER_SYNC_STATE_KEY);
  return normalizeOrderSyncState(stored[ORDER_SYNC_STATE_KEY]);
}

/** State reads and writes share one queue, preventing alarm completions from losing checkpoints. */
let mutationTail: Promise<unknown> = Promise.resolve();

export function runOrderSyncStateMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const task = mutationTail.then(mutation, mutation);
  mutationTail = task.then(() => undefined, () => undefined);
  return task;
}

export async function getOrderSyncStateWithinMutation(): Promise<OrderSyncState> {
  const stored = await chrome.storage.local.get(ORDER_SYNC_STATE_KEY);
  return normalizeOrderSyncState(stored[ORDER_SYNC_STATE_KEY]);
}

export function mutateOrderSyncState(
  mutation: (state: OrderSyncState) => OrderSyncState | Promise<OrderSyncState>,
): Promise<OrderSyncState> {
  return runOrderSyncStateMutation(async () => {
    const current = await getOrderSyncState();
    const next = await mutation(current);
    const normalized = normalizeOrderSyncState(next);
    normalized.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [ORDER_SYNC_STATE_KEY]: normalized });
    return normalized;
  });
}

export async function saveOrderSyncState(state: OrderSyncState): Promise<void> {
  const normalized = normalizeOrderSyncState(state);
  normalized.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [ORDER_SYNC_STATE_KEY]: normalized });
}

export function normalizeOrderSyncState(value: unknown): OrderSyncState {
  const base = createDefaultOrderSyncState();
  if (!isRecord(value)) return base;
  return {
    settings: normalizeOrderSyncSettings(value.settings),
    boundTab: normalizeBoundTab(value.boundTab),
    shopRegion: normalizeShopRegion(value.shopRegion),
    orderProgress: normalizeOrderProgress(value.orderProgress),
    runtimeLogs: normalizeRuntimeLogs(value.runtimeLogs),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : base.createdAt,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : base.updatedAt,
  };
}

function normalizeOrderProgress(value: unknown): OrderDomainProgress {
  const base = createDefaultOrderProgress();
  if (!isRecord(value)) return base;
  const domains = isRecord(value.domains) ? value.domains : {};
  for (const key of ['orders', 'logistics', 'statements'] as OrderDomainKey[]) {
    const row = domains[key];
    if (isRecord(row)) base.domains[key] = normalizeProgressRow(row);
  }
  base.status = value.status === 'running' || value.status === 'ok' || value.status === 'partial'
    ? value.status : 'idle';
  base.lastRunAt = typeof value.lastRunAt === 'string' ? value.lastRunAt : null;
  return base;
}

function normalizeProgressRow(row: Record<string, unknown>): OrderDomainProgressRow {
  const checkpoint = normalizeCheckpoint(row.orderListCheckpoint);
  return {
    total: numberOr(row.total, 0),
    covered: numberOr(row.covered, 0),
    uploaded: numberOr(row.uploaded, 0),
    pending: numberOr(row.pending, 0),
    failed: numberOr(row.failed, 0),
    currentOrderId: stringOrNull(row.currentOrderId),
    currentOrderIndex: numberOrNull(row.currentOrderIndex),
    resumeOrderId: stringOrNull(row.resumeOrderId),
    failedOrderIds: stringArray(row.failedOrderIds),
    snapshotKeys: stringArray(row.snapshotKeys),
    pendingOrderIds: stringArray(row.pendingOrderIds),
    lastFailedOrderId: stringOrNull(row.lastFailedOrderId),
    listPhase: row.listPhase === 'list_fetching' || row.listPhase === 'processing' ? row.listPhase : 'idle',
    listPage: numberOrNull(row.listPage),
    listPageCount: numberOrNull(row.listPageCount),
    listRowsFetched: numberOr(row.listRowsFetched, 0),
    listTotalRows: numberOrNull(row.listTotalRows),
    listOffset: numberOrNull(row.listOffset),
    listSearchCursor: stringOrNull(row.listSearchCursor),
    listPaginationType: numberOrNull(row.listPaginationType),
    serverTotal: numberOrNull(row.serverTotal),
    syncStrategy: row.syncStrategy === 'incremental' || row.syncStrategy === 'fallback' || row.syncStrategy === 'repair'
      ? row.syncStrategy : 'full',
    reconcileStatus: row.reconcileStatus === 'passed' || row.reconcileStatus === 'failed' || row.reconcileStatus === 'unavailable'
      ? row.reconcileStatus : null,
    lastReconciledAt: stringOrNull(row.lastReconciledAt),
    terminalSkipped: numberOr(row.terminalSkipped, 0),
    auditOffset: numberOrNull(row.auditOffset),
    orderListCheckpoint: checkpoint,
    lastSuccessAt: stringOrNull(row.lastSuccessAt),
    lastError: stringOrNull(row.lastError),
    syncRunId: stringOrNull(row.syncRunId),
    syncTrigger: row.syncTrigger === 'manual' || row.syncTrigger === 'automatic' ? row.syncTrigger : null,
    syncRunStatus: row.syncRunStatus === 'running' || row.syncRunStatus === 'done'
      || row.syncRunStatus === 'partial_failed' || row.syncRunStatus === 'interrupted' ? row.syncRunStatus : 'idle',
    lastProgressAt: stringOrNull(row.lastProgressAt),
    nextSyncAt: stringOrNull(row.nextSyncAt),
  };
}

function normalizeCheckpoint(value: unknown): OrderListCheckpoint | null {
  if (!isRecord(value)
    || (value.orderingDirection !== 'asc' && value.orderingDirection !== 'desc')
    || typeof value.windowKey !== 'string'
    || typeof value.capturedAt !== 'string') return null;
  return {
    total: numberOr(value.total, 0),
    headOrderId: stringOrNull(value.headOrderId),
    middleOrderId: stringOrNull(value.middleOrderId),
    tailOrderId: stringOrNull(value.tailOrderId),
    orderingDirection: value.orderingDirection,
    windowKey: value.windowKey,
    auditOffset: numberOr(value.auditOffset, 0),
    lastExactAuditAt: stringOrNull(value.lastExactAuditAt),
    ...(typeof value.statusRefreshVersion === 'number' ? { statusRefreshVersion: value.statusRefreshVersion } : {}),
    capturedAt: value.capturedAt,
  };
}

function normalizeBoundTab(value: unknown): OrderBoundTab | null {
  if (!isRecord(value) || typeof value.tabId !== 'number' || typeof value.url !== 'string') return null;
  return {
    tabId: value.tabId,
    url: value.url,
    ...(typeof value.sellerId === 'string' ? { sellerId: value.sellerId } : {}),
    ...(typeof value.advertiserId === 'string' ? { advertiserId: value.advertiserId } : {}),
    bindMode: value.bindMode === 'auto' ? 'auto' : 'manual',
    boundAt: typeof value.boundAt === 'string' ? value.boundAt : new Date(0).toISOString(),
  };
}

function normalizeShopRegion(value: unknown): OrderSyncState['shopRegion'] {
  if (!isRecord(value) || typeof value.sellerId !== 'string'
    || typeof value.baseUrl !== 'string' || typeof value.region !== 'string') return null;
  return {
    sellerId: value.sellerId,
    baseUrl: value.baseUrl,
    region: value.region,
    ...(value.source === 'server' || value.source === 'manual' ? { source: value.source } : {}),
  };
}

function normalizeRuntimeLogs(value: unknown): OrderRuntimeLog[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(-ORDER_RUNTIME_LOG_LIMIT).map((row) => ({
    id: typeof row.id === 'string' ? row.id : crypto.randomUUID(),
    occurredAt: typeof row.occurredAt === 'string' ? row.occurredAt : new Date(0).toISOString(),
    level: row.level === 'warn' || row.level === 'error' ? row.level : 'info',
    message: typeof row.message === 'string' ? row.message : '',
    context: isRecord(row.context) ? row.context : {},
  }));
}

export function appendOrderRuntimeLog(state: OrderSyncState, log: OrderRuntimeLog): OrderRuntimeLog[] {
  return [...state.runtimeLogs, log].slice(-ORDER_RUNTIME_LOG_LIMIT);
}

function numberOr(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function stringOrNull(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
