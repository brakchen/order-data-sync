/** Migrated orders/logistics/statements engine. Keep behavior aligned with the legacy order checkpoint contract. */

import {
  createOrderSyncDump,
  fetchOrderSyncReconciliation,
  uploadOrderSyncDump,
  type OrderSyncReconcileResult,
  type OrderSyncScope,
  type OrderSyncSettings as OrderApiSettings,
} from '../core/order-sync';
import { createLogisticDetailQuery, createOrderGetRequestBody, createOrderHistoryRequestBody, createOrderListRequestBody, tiktokOrderEndpointUrl, tiktokOrderHistoryEndpointUrl } from '../core/tiktok-order-endpoints';
import { parseSellerIdentityResponse, tiktokSellerIdentityEndpointUrl, type SellerIdentityResponseData } from '../core/tiktok-seller-endpoints';
import { OrderGetResponseSchema, OrderHistoryResponseSchema } from '../core/tiktok-order-endpoint-schemas';
import { isCancelledTikTokOrderRow } from '../core/tiktok-order-status';
import {
  createStatementListQuery,
  createStatementOrderListQuery,
  createStatementTransactionDetailQuery,
  TIKTOK_STATEMENT_API_ORIGIN,
  tiktokStatementEndpointUrl,
} from '../core/tiktok-statement-endpoints';
import {
  extractStatementSkuDetailRefs,
  StatementListResponseSchema,
  StatementOrderListResponseSchema,
  StatementTransactionDetailResponseSchema,
  type StatementSkuDetailRef,
} from '../core/tiktok-statement-endpoint-schemas';
import { createAdaptivePageLoadGuard } from '../core/adaptive-page-load-guard';
import { createRequestRateLimiter } from '../core/request-rate-limiter';
import { normalizeOrderSyncBaseUrl } from '../core/settings';
import {
  checkTtsErpHealth,
  getTtsErpHealthState,
  isTtsErpHealthy,
  resetHealthState,
  startHealthPolling,
  stopHealthPolling,
  type TtsErpHealthState,
} from '../core/tts-erp-health';
import type {
  OrderBoundTab,
  OrderDomainKey,
  OrderDomainProgress,
  OrderDomainProgressRow,
  OrderListCheckpoint,
  OrderRuntimeLog,
  OrderSyncSettings as OrderExtensionSettings,
  OrderSyncState,
  OrderSyncTrigger,
} from '../core/types';
import type { BoundTikTokResponse } from './tiktok-page-response';
import { createChromeBoundPageTransport } from './bound-page-transport';
import { createDefaultOrderProgress, orderSyncStateStore } from './storage';
import { OrderRunCoordinator, type OrderRunLockSnapshot } from './order-run-coordinator';

type OrderPollingDomain = OrderDomainKey;
const ORDER_PAGE_REQUEST_TIMEOUT_MS = 30_000;
// Single-order endpoints can take substantially longer than list pages when
// Seller Center is under load. Keep the list timeout unchanged, but give
// detail/history requests enough time to finish before retrying the item.
const ORDER_ITEM_REQUEST_TIMEOUT_MS = 60_000;
const SELLER_IDENTITY_PROBE_TIMEOUT_MS = 2_500;
const MAX_RUNTIME_LOGS = 5_000;
export const ORDER_SYNC_ALARMS = {
  orders: 'order-data-sync:orders',
  logistics: 'order-data-sync:logistics',
  statements: 'order-data-sync:statements',
  order_details: 'order-data-sync:order-details',
  order_history: 'order-data-sync:order-history',
  ordersContinue: 'order-data-sync:orders:continue',
  logisticsContinue: 'order-data-sync:logistics:continue',
  statementsContinue: 'order-data-sync:statements:continue',
  orderDetailsContinue: 'order-data-sync:order-details:continue',
  orderHistoryContinue: 'order-data-sync:order-history:continue',
} as const;
export const SELLER_TAB_ALARMS = {
  refresh: 'order-data-sync:seller-tab-refresh',
  watch: 'order-data-sync:seller-tab-watch',
} as const;
export const SELLER_TAB_WATCH_DELAY_MINUTES = 1;
const TIKTOK_SELLER_CENTER_ORIGINS = [
  'https://seller.tiktokglobalshop.com',
  'https://seller.tiktokshopglobalselling.com',
] as const;

function isOrderDomainSyncEnabled(settings: OrderExtensionSettings): boolean {
  return settings.orderDomainSyncEnabled && !settings.syncPaused;
}

function runtimeLogContext(
  component: string,
  event: string,
  outcome: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  const { rawRequest, rawResponse, ...safeDetails } = details;
  return {
    schemaVersion: 1,
    component,
    event,
    outcome,
    ...(Object.keys(safeDetails).length ? { details: safeDetails } : {}),
    ...(rawRequest === undefined ? {} : { request: sanitizeRuntimeLogValue(rawRequest) }),
    ...(rawResponse === undefined ? {} : { response: sanitizeRuntimeLogValue(rawResponse) }),
  };
}
const RUNTIME_SECRET_KEY = /(token|auth|authorization|cookie|password|secret|credential|signature|bsid|access[_-]?key|refresh[_-]?token)/i;

type SanitizedRuntimeLogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SanitizedRuntimeLogValue[]
  | { [key: string]: SanitizedRuntimeLogValue };

function sanitizeRuntimeLogValue(value: unknown): SanitizedRuntimeLogValue {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return sanitizeRuntimeUrl(value);
    return sanitizeDiagnosticText(value).slice(0, 20_000);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeRuntimeLogValue(item));
  if (value === null || value === undefined
    || typeof value === 'number' || typeof value === 'boolean') return value;
  if (!isRecord(value)) return String(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    RUNTIME_SECRET_KEY.test(key) ? '[REDACTED]' : sanitizeRuntimeLogValue(item),
  ]));
}

function sanitizeRuntimeUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (RUNTIME_SECRET_KEY.test(key) || /^(fp|verify)$/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    url.hash = '';
    return url.toString().slice(0, 4_000);
  } catch {
    return sanitizeDiagnosticText(value).slice(0, 4_000);
  }
}

function summarizeRuntimeValueShape(value: unknown): { fields: string[] } {
  if (!isRecord(value)) return { fields: [] };
  return {
    fields: Object.entries(value)
      .filter(([key]) => !/(token|auth|cookie|password|secret|credential|signature)/i.test(key))
      .slice(0, 32)
      .map(([key, item]) => `${key}:${Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item}`),
  };
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|cookie|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function isTikTokLoginRequiredResponse(response: unknown): boolean {
  if (!isRecord(response)) return false;
  const extra = isRecord(response.extra) ? response.extra : {};
  return response.code === 11000 || response.code === '11000' || extra.i18n_key === 'not_login';
}

async function clearOrderBinding(
  expectedState: OrderSyncState,
  reason = 'unknown',
): Promise<void> {
  let cleared = false;
  await orderSyncStateStore.update((current) => {
    if (current.boundTab?.tabId !== expectedState.boundTab?.tabId
      || current.boundTab?.sellerId !== expectedState.boundTab?.sellerId
      || normaliseOrderSyncBaseUrl(current.settings.syncBaseUrl)
        !== normaliseOrderSyncBaseUrl(expectedState.settings.syncBaseUrl)
      || current.settings.syncToken.trim() !== expectedState.settings.syncToken.trim()
      || !current.boundTab) return current;
    const { sellerId: _sellerId, ...boundTabWithoutSellerId } = current.boundTab;
    cleared = true;
    return {
      ...current,
      boundTab: boundTabWithoutSellerId,
      shopRegion: null,
    };
  });
  if (!cleared) return;
  for (const name of Object.values(ORDER_SYNC_ALARMS)) {
    await chrome.alarms.clear(name);
  }
  for (const name of Object.values(SELLER_TAB_ALARMS)) {
    await chrome.alarms.clear(name);
  }
  await chrome.alarms.create(SELLER_TAB_ALARMS.watch, {
    delayInMinutes: SELLER_TAB_WATCH_DELAY_MINUTES,
  });
  // 停止探活轮询
  stopTtsErpHealthPolling();
  await recordOrderSyncRuntimeLog('all', 'seller_binding_auth_expired', 'skipped', 'Seller Center 会话已失效，已停止同步并保留断点，等待重新登录或同域名页面接管。', {
    stage: 'seller_binding',
    reason,
    tabId: expectedState.boundTab?.tabId ?? null,
    syncStopped: true,
    sellerIdRemoved: true,
    preservedProgress: true,
    replacementScanScheduled: true,
  });
}

export async function reportSchedulerError(
  error: unknown,
  details: Record<string, unknown> = {},
): Promise<void> {
  await recordOrderSyncRuntimeLog('all', 'scheduler_error', 'failed', '订单同步调度异常，保留断点等待重试。', {
    ...details,
    error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)).slice(0, 240),
  });
}


// ─── 订单 / 物流 / 结算：后台主动拉取 ──────────────────────────────
//
// 与广告域不同，订单域不走「页面 hook 观测 → content 转发 → 后台消费」三段接线
// （0.1.127 起那条链已断，挂在页面上只是白抓），而是由后台按 alarm 经绑定的
// Seller Center tab 主动请求接口，再上传到 tts-erp 的 /v2/order-sync/*。
//
// 三个域的成本差很多，所以节奏分开：
//   orders     → 列表 1 次请求就带全字段
//   logistics  → 每单 1 次详情（N+1）
//   statements → 全局结算列表分页（不按订单拼接）
// 后者逐单之间强制 ORDER_DETAIL_FETCH_DELAY_MS 间隔；订单域实体是可变的，
// 不能用后端存在性查询代替新鲜度判断，因此每轮按 Seller Center 当前结果刷新。
const ORDER_SYNC_ALARM = ORDER_SYNC_ALARMS.orders;

const ORDER_SYNC_NEXT_DELAY_MINUTES = 24 * 60;

const LOGISTICS_SYNC_ALARM = ORDER_SYNC_ALARMS.logistics;

const LOGISTICS_SYNC_NEXT_DELAY_MINUTES = 24 * 60;

const LOGISTICS_CONTINUATION_ALARM = ORDER_SYNC_ALARMS.logisticsContinue;

const LOGISTICS_CONTINUATION_DELAY_MINUTES = 0.1;

const SETTLEMENT_SYNC_ALARM = ORDER_SYNC_ALARMS.statements;

const SETTLEMENT_SYNC_NEXT_DELAY_MINUTES = 24 * 60;

const ORDER_CONTINUATION_ALARM = ORDER_SYNC_ALARMS.ordersContinue;

const SETTLEMENT_CONTINUATION_ALARM = ORDER_SYNC_ALARMS.statementsContinue;

const ORDER_DETAILS_SYNC_ALARM = ORDER_SYNC_ALARMS.order_details;

const ORDER_DETAILS_SYNC_NEXT_DELAY_MINUTES = 24 * 60;

const ORDER_DETAILS_CONTINUATION_ALARM = ORDER_SYNC_ALARMS.orderDetailsContinue;

const ORDER_HISTORY_SYNC_ALARM = ORDER_SYNC_ALARMS.order_history;

const ORDER_HISTORY_SYNC_NEXT_DELAY_MINUTES = 24 * 60;

const ORDER_HISTORY_CONTINUATION_ALARM = ORDER_SYNC_ALARMS.orderHistoryContinue;

const ORDER_DOMAIN_CONTINUATION_DELAY_MINUTES = 0.1;

const ORDER_DOMAIN_BUSY_RETRY_DELAY_MINUTES = 1;

/** A persisted order-domain run with no progress this long can be recovered by the user. */
const ORDER_DOMAIN_STUCK_AFTER_MS = 2 * 60_000;

const ORDER_DOMAIN_STOP_WAIT_MS = 25_000;

/** 逐单详情请求之间的最小间隔（N+1 防风控）。 */
const ORDER_DETAIL_FETCH_DELAY_MS = 3_000;

/** 物流每轮最多处理的详情数；游标会持久化，下一轮从未完成位置继续。 */
const LOGISTICS_BATCH_SIZE = 50;

/** 订单和结算每轮最多处理的条目数；游标会持久化，下一轮从未完成位置继续。 */
const ORDER_DOMAIN_BATCH_SIZE = 50;

/** 每轮订单列表拉取条数。 */
const ORDER_LIST_PAGE_SIZE = 20;

const ORDER_HISTORY_PAGE_SIZE = 10;

const MAX_ORDER_HISTORY_PAGES = 500;

const STATEMENT_LIST_PAGE_SIZE = 50;

const MAX_ORDER_LIST_PAGES = 500;

const MAX_STATEMENT_LIST_PAGES = 500;

const ORDER_RECONCILE_HOT_WINDOW_SIZE = 40;

const ORDER_CHECKPOINT_AUDIT_WINDOW_SIZE = 40;

const ORDER_CHECKPOINT_EXACT_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const ORDER_STATUS_REFRESH_CHECKPOINT_VERSION = 1;

/** TikTok order-list request `sort_info=6` is the current descending contract. */
const ORDER_LIST_DIRECTION: 'asc' | 'desc' = 'desc';

const ORDER_RECONCILE_MAX_LOGISTICS_PAGES = 20;

/** 普通模式每 500ms 启动一个请求，理论上限 120 请求/分钟。 */
const TIKTOK_PAGINATION_PAGE_DELAY_MS = 500;

/**
 * All TikTok page requests share one serial admission lane.  A single Seller
 * Center tab is the source of truth, so allowing different domains to overlap
 * only increases verification risk without improving data correctness.
 */
const tiktokRequests = createRequestRateLimiter({
  intervalMs: TIKTOK_PAGINATION_PAGE_DELAY_MS,
  maxInFlight: 1,
});

const TIKTOK_ENDPOINT_HARD_FAILURE_THRESHOLD = 10;
type TikTokEndpointFailureState = { consecutive: number; tripped: boolean };
const tiktokEndpointFailures = new Map<string, TikTokEndpointFailureState>();
let tiktokEndpointCircuitOpen = false;


type InitialOrderSyncTrigger = 'extension_startup' | 'configuration_ready';


/**
 * Protect the Seller Center tab only after sustained slow page responses.
 * Healthy requests retain the existing 8 in-flight / 500ms start policy.
 */
const tiktokPageLoadGuard = createAdaptivePageLoadGuard({
  slowThresholdMs: 4_000,
  slowConsecutiveThreshold: 2,
  fastConsecutiveThreshold: 4,
  stepMs: 250,
  maxDelayMs: 3_000,
});


/** Consecutive page-side timeouts trigger a bounded cool-down for all TikTok work. */
const TIKTOK_TIMEOUT_BACKOFF_THRESHOLD = 3;

const TIKTOK_TIMEOUT_BACKOFF_BASE_MS = 5_000;

const TIKTOK_TIMEOUT_BACKOFF_MAX_MS = 60_000;

let tiktokTimeoutStreak = 0;

let tiktokBackoffUntil = 0;


async function waitForTikTokTimeoutBackoff(signal?: AbortSignal): Promise<number> {
  const waitMs = Math.max(0, tiktokBackoffUntil - Date.now());
  if (waitMs > 0) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(done, waitMs);
      const abort = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        reject(new DOMException('TikTok backoff wait aborted', 'AbortError'));
      };
      function done() {
        signal?.removeEventListener('abort', abort);
        resolve();
      }
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  return waitMs;
}


async function waitForAdaptivePageDelay(delayMs: number, signal?: AbortSignal): Promise<number> {
  const waitMs = Math.max(0, Math.round(delayMs));
  if (waitMs === 0) return 0;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, waitMs);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('Adaptive page delay aborted', 'AbortError'));
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
  return waitMs;
}


function noteTikTokTimeout(): Record<string, unknown> {
  tiktokTimeoutStreak += 1;
  const backoffMs = tiktokTimeoutStreak < TIKTOK_TIMEOUT_BACKOFF_THRESHOLD
    ? 0
    : Math.min(
      TIKTOK_TIMEOUT_BACKOFF_MAX_MS,
      TIKTOK_TIMEOUT_BACKOFF_BASE_MS * 2 ** (tiktokTimeoutStreak - TIKTOK_TIMEOUT_BACKOFF_THRESHOLD),
    );
  tiktokBackoffUntil = backoffMs > 0 ? Date.now() + backoffMs : 0;
  return {
    tiktokTimeoutStreak,
    tiktokBackoffMs: backoffMs,
    ...(backoffMs > 0 ? { tiktokRetryAt: new Date(tiktokBackoffUntil).toISOString() } : {}),
  };
}


function resetTikTokTimeoutBackoff(): void {
  tiktokTimeoutStreak = 0;
  tiktokBackoffUntil = 0;
}


/** Each outbound TikTok request uses the single serial limiter. */
export function tiktokRequestPacer(): {
  acquire: (signal?: AbortSignal) => Promise<() => void>;
} {
  return { acquire: (signal) => tiktokRequests.acquire(0, signal) };
}

function tikTokEndpointKey(url: string): string {
  return orderTikTokEndpointPath(url);
}

function assertTikTokEndpointCircuitClosed(url: string): void {
  const endpoint = tikTokEndpointKey(url);
  const endpointState = tiktokEndpointFailures.get(endpoint);
  if (tiktokEndpointCircuitOpen || endpointState?.tripped) {
    throw new StopOrderDomainBatch(`TikTok 接口 ${endpoint} 已触发连续 401/404 熔断，已停止继续请求和上传；需要人工排查后恢复。`);
  }
}

async function noteTikTokEndpointResponse(url: string, response: BoundTikTokResponse): Promise<void> {
  const endpoint = tikTokEndpointKey(url);
  const previous = tiktokEndpointFailures.get(endpoint) ?? { consecutive: 0, tripped: false };
  if (response.status !== 401 && response.status !== 404) {
    if (previous.consecutive > 0) tiktokEndpointFailures.delete(endpoint);
    return;
  }
  const consecutive = previous.consecutive + 1;
  const next = { consecutive, tripped: previous.tripped || consecutive >= TIKTOK_ENDPOINT_HARD_FAILURE_THRESHOLD };
  tiktokEndpointFailures.set(endpoint, next);
  if (!next.tripped || previous.tripped) return;
  tiktokEndpointCircuitOpen = true;
  await orderSyncStateStore.update((current) => {
    const now = new Date().toISOString();
    const log: OrderRuntimeLog = {
      id: `order-sync-all-endpoint_circuit_open-${crypto.randomUUID()}`,
      occurredAt: now,
      level: 'error',
      message: `TikTok 接口 ${endpoint} 连续 ${consecutive} 次返回 HTTP ${response.status}，已停止请求下游 TTS-ERP。`,
      context: runtimeLogContext('order_sync', 'endpoint_circuit_open', 'failed', {
        endpoint,
        httpStatus: response.status,
        consecutiveFailures: consecutive,
        threshold: TIKTOK_ENDPOINT_HARD_FAILURE_THRESHOLD,
        stage: 'tiktok_request_guard',
        manualInterventionRequired: true,
      }),
    };
    return {
      ...current,
      settings: { ...current.settings, syncPaused: true },
      endpointCircuit: {
        endpoint,
        httpStatus: response.status,
        consecutiveFailures: consecutive,
        threshold: TIKTOK_ENDPOINT_HARD_FAILURE_THRESHOLD,
        openedAt: now,
      },
      runtimeLogs: [...current.runtimeLogs, log].slice(-MAX_RUNTIME_LOGS),
    };
  });
}

export function resetTikTokEndpointCircuit(): void {
  tiktokEndpointCircuitOpen = false;
  tiktokEndpointFailures.clear();
}


// ─── 订单域后台轮询 ────────────────────────────────────────────

/**
 * Resolve the region captured from Seller Center or cached from the ERP
 * lookup.  Region is required by the Seller Center request contract; an
 * empty fallback silently produces requests for the wrong shop scope.
 */
export function orderShopRegion(state: OrderSyncState): string | null {
  const sellerId = state.boundTab?.sellerId;
  const shopRegion = state.shopRegion;
  const cached = shopRegion && shopRegion.sellerId === sellerId ? shopRegion.region.trim() : '';
  const captured = state.boundTab?.shopRegion?.trim() ?? '';
  return cached || captured || null;
}

/** 拉取前置条件：已绑定店铺 + Seller 地区 + 有令牌 + 未被暂停。 */
async function orderPollingState(): Promise<OrderSyncState | null> {
  const state = await orderSyncStateStore.read();
  const boundTab = state.boundTab;
  if (!boundTab?.tabId || !boundTab.sellerId) return null;
  if (!orderShopRegion(state)) return null;
  if (!state.settings.syncToken.trim()) return null;
  if (state.settings.syncPaused === true) return null;
  // 0.1.149+：移除 autoPausedReason 全局熔断。needsHuman 是 per-unit，dumpWork 自然跳过。
  if (!isOrderDomainSyncEnabled(state.settings)) return null;
  // tts-erp 探活门控：/healthz 不可达时暂停所有同步，等待恢复。
  if (!isTtsErpHealthy()) return null;
  return state;
}


/** Configuration is complete only when the bound seller can reach the ERP. */
function hasOrderDomainSyncConfiguration(state: OrderSyncState): boolean {
  return Boolean(
    state.boundTab?.tabId
    && state.boundTab.sellerId
    && orderShopRegion(state)
    && state.settings.syncBaseUrl.trim()
    && state.settings.syncToken.trim()
    && state.settings.syncPaused !== true
    && isOrderDomainSyncEnabled(state.settings),
  );
}


function orderSyncSettingsFor(state: OrderSyncState): OrderApiSettings {
  return { syncBaseUrl: state.settings.syncBaseUrl, syncToken: state.settings.syncToken.trim() };
}


function orderSyncScopeFor(state: OrderSyncState): OrderSyncScope {
  const boundTab = state.boundTab!;
  // TTS-ERP 的 shop_id 对应 Seller 店铺身份；Advertiser 只属于广告域，
  // 即使页面同时提供它，也不能拿它替代订单域的 shopId。
  return { sellerId: boundTab.sellerId!, shopId: boundTab.sellerId! };
}


/** Prevent a long order/logistics pass from writing after a shop or token changed. */
async function isOrderSyncScopeCurrent(expected: OrderSyncState): Promise<boolean> {
  const current = await orderSyncStateStore.read();
  return current.boundTab?.tabId === expected.boundTab?.tabId
    && current.boundTab?.sellerId === expected.boundTab?.sellerId
    && normaliseOrderSyncBaseUrl(current.settings.syncBaseUrl) === normaliseOrderSyncBaseUrl(expected.settings.syncBaseUrl)
    && current.settings.syncToken.trim() === expected.settings.syncToken.trim()
    && orderShopRegion(current) === orderShopRegion(expected)
    && current.settings.syncPaused !== true
    && isOrderDomainSyncEnabled(current.settings);
}


function normaliseOrderSyncBaseUrl(value: string): string {
  return normalizeOrderSyncBaseUrl(value);
}

function boundSellerCenterOrigin(pageUrl: string | undefined): string {
  try {
    const origin = new URL(pageUrl ?? '').origin;
    if (TIKTOK_SELLER_CENTER_ORIGINS.includes(origin as typeof TIKTOK_SELLER_CENTER_ORIGINS[number])) return origin;
  } catch {
    // Retain the original contract's canonical origin fallback.
  }
  return TIKTOK_SELLER_CENTER_ORIGINS[0];
}


/** Keep shape diagnostics separate from the explicit raw exchange attached to runtime logs. */
function orderTikTokResponseDiagnostics(response: BoundTikTokResponse): Record<string, unknown> {
  return {
    ...tiktokResponseDiagnostic(response.status, response.payload),
    ok: response.ok,
    ...(response.requestMode === undefined ? {} : { requestMode: response.requestMode }),
    ...(response.responseReadError === undefined ? {} : { responseReadError: response.responseReadError }),
    ...(response.responseContentType === undefined ? {} : { responseContentType: response.responseContentType }),
    ...(response.responseTextLength === undefined ? {} : { responseTextLength: response.responseTextLength }),
    ...(response.transportError === undefined ? {} : { transportError: response.transportError }),
    ...(response.timings === undefined ? {} : response.timings),
  };
}


/** Attach the complete TikTok exchange to plugin_logs without passing it through the shape-only diagnostics path. */
function orderTikTokRuntimeExchange(
  method: 'GET' | 'POST',
  url: string,
  requestBody: Record<string, unknown> | undefined,
  response?: BoundTikTokResponse,
): Record<string, unknown> {
  return {
    rawRequest: {
      method,
      url,
      ...(requestBody === undefined ? {} : { body: requestBody }),
    },
    ...(response === undefined ? {} : {
      rawResponse: {
        status: response.status,
        body: response.payload !== null
          ? response.payload
          : response.responseText ?? null,
      },
    }),
  };
}


/** The order-sync backend accepts JSON objects (or null for an upstream empty body). */
function orderSyncDumpBody(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}


function tiktokBusinessFailure(value: unknown, label: string): string | null {
  if (!isRecord(value) || value.code !== 0) {
    const code = isRecord(value) ? String(value.code ?? 'missing') : 'missing';
    const message = isRecord(value) && typeof value.message === 'string'
      ? `: ${sanitizeDiagnosticText(value.message).slice(0, 160)}`
      : '';
    return `${label} business code ${code}${message}`;
  }
  return null;
}


function orderTikTokEndpointPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.slice(0, 160);
  }
}


function orderTikTokFailureSummary(label: string, response: BoundTikTokResponse): string {
  const parts = [`HTTP ${response.status}`];
  if (response.transportError) parts.push(response.transportError);
  if (response.responseReadError) parts.push(response.responseReadError);
  if (typeof response.responseTextLength === 'number') parts.push(`响应 ${response.responseTextLength}B`);
  if (response.responseContentType) parts.push(`类型 ${response.responseContentType}`);
  return `${label}（${parts.join('，')}）`;
}


function orderRequestExceptionDetails(error: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = {
    errorName: error instanceof Error ? error.name : 'UnknownError',
    error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)).slice(0, 240),
  };
  if (!isRecord(error)) return details;
  if (typeof error.code === 'string') details.syncErrorCode = error.code.slice(0, 64);
  if (typeof error.timeoutMs === 'number' && Number.isFinite(error.timeoutMs)) {
    details.timeoutMs = error.timeoutMs;
    details.transportFailure = 'timeout';
  }
  if (typeof error.httpStatus === 'number' && Number.isFinite(error.httpStatus)) details.httpStatus = error.httpStatus;
  if (typeof error.operation === 'string') details.operation = error.operation.slice(0, 64);
  if (error.operation === 'dump') {
    details.retryQueued = true;
    details.retryQueue = 'pendingOrderIds';
    details.retryMechanism = 'order-domain-continuation-alarm';
  }
  if (typeof error.transportFailure === 'string') details.transportFailure = error.transportFailure.slice(0, 32);
  if (isRecord(error.requestDiagnostics)) {
    const requestDiagnostics = error.requestDiagnostics;
    if (typeof requestDiagnostics.endpoint === 'string') {
      details.requestEndpoint = orderTikTokEndpointPath(requestDiagnostics.endpoint);
      try {
        details.requestOrigin = new URL(requestDiagnostics.endpoint).origin;
      } catch {
        // Keep the safe path diagnostic when the endpoint is not an absolute URL.
      }
    }
    if (typeof requestDiagnostics.requestId === 'string') details.requestId = requestDiagnostics.requestId.slice(0, 128);
    if (typeof requestDiagnostics.attempts === 'number') details.attempts = requestDiagnostics.attempts;
    if (typeof requestDiagnostics.totalDurationMs === 'number') details.totalDurationMs = Math.max(0, requestDiagnostics.totalDurationMs);
    if (typeof requestDiagnostics.lastAttemptDurationMs === 'number') {
      details.lastAttemptDurationMs = Math.max(0, requestDiagnostics.lastAttemptDurationMs);
    }
    if (typeof requestDiagnostics.transportFailure === 'string') {
      details.transportFailure = requestDiagnostics.transportFailure.slice(0, 32);
    }
    if (typeof requestDiagnostics.lastErrorName === 'string') details.lastErrorName = requestDiagnostics.lastErrorName.slice(0, 64);
    if (typeof requestDiagnostics.lastErrorMessage === 'string') {
      details.lastErrorMessage = sanitizeDiagnosticText(requestDiagnostics.lastErrorMessage).slice(0, 240);
    }
  }
  if (isRecord(error.diagnostic)) {
    if (typeof error.diagnostic.serverCode === 'string') {
      details.serverCode = error.diagnostic.serverCode.slice(0, 64);
    }
    if (typeof error.diagnostic.serverRequestId === 'string') {
      details.serverRequestId = error.diagnostic.serverRequestId.slice(0, 128);
    }
    if (Array.isArray(error.diagnostic.responseFields)) {
      details.serverResponseFields = error.diagnostic.responseFields
        .filter((field): field is string => typeof field === 'string')
        .slice(0, 32);
    }
  }
  return details;
}


function resetOrderListProgress(): Pick<OrderDomainProgressRow, 'listPhase' | 'listPage' | 'listPageCount' | 'listRowsFetched' | 'listTotalRows' | 'listOffset' | 'listSearchCursor' | 'listPaginationType'> {
  return {
    listPhase: 'idle',
    listPage: null,
    listPageCount: null,
    listRowsFetched: 0,
    listTotalRows: null,
    listOffset: null,
    listSearchCursor: null,
    listPaginationType: null,
  };
}


type OrderListRow = { orderId: string; row: Record<string, unknown>; status: number };


type OrderListFetchResult = {
  rows: OrderListRow[];
  totalRows: number | null;
};


type OrderListPage = {
  rows: OrderListRow[];
  /** Raw page rows retained for the page-coupled logistics consumer. */
  allRows?: OrderListRow[];
  page: number;
  pageCount: number | null;
  fetchedRows: number;
  totalRows: number | null;
  /** Offset actually sent to TikTok; cursor pages may intentionally repeat it. */
  requestOffset: number;
  /** Position in the de-duplicated logical list used by checkpoint/audit logic. */
  logicalOffset: number;
  searchCursor: string;
  paginationType: number;
  hasMore: boolean;
};


type OrderListFetchOptions = {
  startOffset?: number;
  maxRows?: number;
  /** When present, process each page immediately instead of waiting for the full list. */
  onPage?: (page: OrderListPage) => Promise<void>;
};


type OrderPagePipeline = {
  onPage: (page: OrderListPage) => Promise<void>;
  /** Own every in-memory consumer until its durable batch checkpoint is written. */
  drain: () => Promise<void>;
};


type OrderRoundSelection = {
  rows: OrderListRow[];
  strategy: 'full' | 'incremental' | 'fallback' | 'repair';
  reconcileStatus: 'passed' | 'failed' | 'unavailable';
  serverTotal: number | null;
  nextAuditOffset?: number | null;
  checkpoint?: OrderListCheckpoint | null;
  streamed?: boolean;
};


type LogisticsRoundSelection = {
  rows: OrderListRow[];
  strategy: 'incremental' | 'fallback';
  reconcileStatus: 'passed' | 'unavailable';
  terminalSkipped: number;
};


function reconcileAnchorPositions(previous: OrderDomainProgressRow): number[] {
  const checkpoint = Math.max(0, Math.floor(
    previous.orderListCheckpoint?.total ?? previous.listTotalRows ?? previous.total ?? 0,
  ));
  if (checkpoint === 0) return [0];
  return [...new Set([0, Math.floor((checkpoint - 1) / 2), checkpoint - 1])];
}


async function fetchOrderReconciliation(
  state: OrderSyncState,
  settings: OrderApiSettings,
  scope: OrderSyncScope,
  domain: 'orders' | 'logistics',
  cursor?: string,
): Promise<OrderSyncReconcileResult | null> {
  const previous = state.orderProgress?.domains[domain] ?? createDefaultOrderProgress().domains[domain];
  try {
    const result = await fetchOrderSyncReconciliation(settings, scope, {
      domains: [domain],
      ...(domain === 'orders' ? {
        orders: {
          pageSize: ORDER_LIST_PAGE_SIZE,
          sortInfo: '6',
          anchorPositions: reconcileAnchorPositions(previous),
          hotWindowSize: ORDER_RECONCILE_HOT_WINDOW_SIZE,
        },
      } : {
        logistics: { limit: 500, ...(cursor === undefined ? {} : { cursor }) },
      }),
    });
    await recordOrderSyncRuntimeLog(domain, 'reconcile', 'succeeded', '统一同步状态查询完成。', {
      stage: 'server_reconcile',
      serverTotal: result.orders?.serverTotal ?? null,
      anchorCount: result.orders?.anchors.length ?? 0,
      logisticsComplete: result.logistics?.complete ?? null,
      logisticsCandidateCount: result.logistics?.items.length ?? null,
    });
    return result;
  } catch (error) {
    // The endpoint is diagnostic for orders. Until tts-erp is deployed, or
    // when it is temporarily unavailable, the local checkpoint still decides
    // whether the order list can use the fast path.
    await recordOrderSyncRuntimeLog(domain, 'reconcile', 'skipped', '统一同步状态查询不可用，本轮回退旧的全量读取。', {
      stage: 'server_reconcile',
      ...orderRequestExceptionDetails(error),
    });
    return null;
  }
}


function orderListWindowKey(): string {
  return new Date().toISOString().slice(0, 10);
}


function orderRetryKeys(previous: OrderDomainProgressRow): Set<string> {
  return new Set([
    ...(previous.pendingOrderIds ?? []),
    ...(previous.failedOrderIds ?? []),
    ...(previous.resumeOrderId ? [previous.resumeOrderId] : []),
    ...(previous.currentOrderId ? [previous.currentOrderId] : []),
  ]);
}


function checkpointAnchorEntries(checkpoint: OrderListCheckpoint): Array<{ position: number; orderId: string }> {
  const entries = [
    { position: 0, orderId: checkpoint.headOrderId },
    { position: Math.floor(Math.max(0, checkpoint.total - 1) / 2), orderId: checkpoint.middleOrderId },
    { position: Math.max(0, checkpoint.total - 1), orderId: checkpoint.tailOrderId },
  ];
  return entries.filter((entry): entry is { position: number; orderId: string } => entry.orderId !== null);
}


function buildOrderListCheckpoint(
  total: number,
  direction: 'asc' | 'desc',
  windowKey: string,
  auditOffset: number,
  lastExactAuditAt: string | null,
  anchors: Map<number, OrderListRow>,
): OrderListCheckpoint | null {
  if (!Number.isInteger(total) || total < 0) return null;
  const middlePosition = Math.floor(Math.max(0, total - 1) / 2);
  const tailPosition = Math.max(0, total - 1);
  if (total > 0 && (!anchors.get(0) || !anchors.get(middlePosition) || !anchors.get(tailPosition))) return null;
  return {
    total,
    headOrderId: anchors.get(0)?.orderId ?? null,
    middleOrderId: anchors.get(middlePosition)?.orderId ?? null,
    tailOrderId: anchors.get(tailPosition)?.orderId ?? null,
    orderingDirection: direction,
    windowKey,
    auditOffset: Math.max(0, Math.floor(auditOffset)),
    lastExactAuditAt,
    statusRefreshVersion: ORDER_STATUS_REFRESH_CHECKPOINT_VERSION,
    capturedAt: new Date().toISOString(),
  };
}


function isExactOrderAuditDue(checkpoint: OrderListCheckpoint | null | undefined): boolean {
  if (checkpoint?.statusRefreshVersion !== ORDER_STATUS_REFRESH_CHECKPOINT_VERSION) return true;
  if (!checkpoint?.lastExactAuditAt) return true;
  const capturedAt = Date.parse(checkpoint.lastExactAuditAt);
  return !Number.isFinite(capturedAt) || Date.now() - capturedAt >= ORDER_CHECKPOINT_EXACT_AUDIT_INTERVAL_MS;
}


async function fetchOrderRowsForRound(
  state: OrderSyncState,
  settings: OrderApiSettings,
  scope: OrderSyncScope,
  reconciliation: OrderSyncReconcileResult | null,
  previous: OrderDomainProgressRow,
  onPage?: (page: OrderListPage) => Promise<void>,
): Promise<OrderRoundSelection> {
  const reconcileState = reconciliation?.orders;
  const previousCheckpoint = previous.orderListCheckpoint ?? null;
  // The current direction comes from the request contract, never from the
  // previous checkpoint. Otherwise comparing the two would be tautological
  // and a persisted checkpoint with an old direction could never trigger repair.
  const direction = ORDER_LIST_DIRECTION;
  const hotWindowSize = Math.max(0, reconcileState?.hotWindowSize ?? ORDER_RECONCILE_HOT_WINDOW_SIZE);
  const windowKey = orderListWindowKey();
  const retryKeys = orderRetryKeys(previous);
  let streamedPageSeen = false;
  const emitPage = async (page: OrderListPage, rows: OrderListRow[]): Promise<void> => {
    if (!onPage) return;
    streamedPageSeen = true;
    await onPage({ ...page, rows, allRows: page.rows });
  };
  const runRepair = async (
    status: 'failed' | 'unavailable' = 'unavailable',
  ): Promise<OrderRoundSelection> => {
    const checkpointAnchors = new Map<number, OrderListRow>();
    const captureAndFilter = async (page: OrderListPage): Promise<void> => {
      const total = page.totalRows ?? 0;
      const positions = [0, Math.floor(Math.max(0, total - 1) / 2), Math.max(0, total - 1)];
      page.rows.forEach((row, index) => {
        const position = page.logicalOffset + index;
        if (positions.includes(position)) checkpointAnchors.set(position, row);
      });
      await emitPage(page, page.rows);
    };
    const result = await fetchOrderListRows(state, 'orders', onPage ? { onPage: captureAndFilter } : {});
    const total = result.totalRows ?? result.rows.length;
    const selectedRows = onPage ? [] : result.rows;
    const checkpoint = buildOrderListCheckpoint(
      total,
      direction,
      windowKey,
      total > hotWindowSize ? hotWindowSize : 0,
      new Date().toISOString(),
      checkpointAnchors,
    );
    if (onPage) {
      return {
        rows: [],
        strategy: 'repair',
        reconcileStatus: status,
        serverTotal: reconcileState?.serverTotal ?? result.totalRows,
        nextAuditOffset: checkpoint?.auditOffset ?? previous.auditOffset ?? null,
        checkpoint,
        streamed: true,
      };
    }
    return {
      rows: selectedRows,
      strategy: 'repair',
      reconcileStatus: status,
      serverTotal: reconcileState?.serverTotal ?? null,
      nextAuditOffset: checkpoint?.auditOffset ?? previous.auditOffset ?? null,
      checkpoint,
    };
  };

  const hasDurableRetryQueue = (previous.pendingOrderIds?.length ?? 0) > 0
    || (previous.failedOrderIds?.length ?? 0) > 0
    || previous.resumeOrderId != null
    || previous.currentOrderId != null;
  if (!previousCheckpoint || previousCheckpoint.windowKey !== windowKey || isExactOrderAuditDue(previousCheckpoint)) {
    return runRepair(previousCheckpoint ? 'failed' : 'unavailable');
  }
  if (hasDurableRetryQueue) return runRepair('failed');

  const pageCache = new Map<number, OrderListFetchResult>();
  const firstPage = await fetchOrderListRows(state, 'orders', { startOffset: 0, maxRows: ORDER_LIST_PAGE_SIZE });
  pageCache.set(0, firstPage);
  const tiktokTotal = firstPage.totalRows;
  if (tiktokTotal === null || tiktokTotal < previousCheckpoint.total || direction !== previousCheckpoint.orderingDirection) {
    return runRepair('failed');
  }
  const newCount = Math.max(0, tiktokTotal - previousCheckpoint.total);
  const readAt = async (position: number): Promise<OrderListRow | undefined> => {
    const safePosition = Math.max(0, Math.floor(position));
    const pageOffset = Math.floor(safePosition / ORDER_LIST_PAGE_SIZE) * ORDER_LIST_PAGE_SIZE;
    let page = pageCache.get(pageOffset);
    if (!page) {
      page = await fetchOrderListRows(state, 'orders', { startOffset: pageOffset, maxRows: ORDER_LIST_PAGE_SIZE });
      pageCache.set(pageOffset, page);
    }
    return page.rows[safePosition - pageOffset];
  };
  const currentAnchors = new Map<number, OrderListRow>();
  for (const anchor of checkpointAnchorEntries(previousCheckpoint)) {
    const currentPosition = direction === 'desc' ? newCount + anchor.position : anchor.position;
    const row = await readAt(currentPosition);
    if (!row || row.orderId !== anchor.orderId) return runRepair('failed');
  }
  for (const position of [0, Math.floor(Math.max(0, tiktokTotal - 1) / 2), Math.max(0, tiktokTotal - 1)]) {
    const row = await readAt(position);
    if (row) currentAnchors.set(position, row);
  }
  const hotFetchSize = direction === 'desc'
    ? Math.min(tiktokTotal, Math.max(hotWindowSize, newCount))
    : hotWindowSize;
  const emitHot = onPage
    ? async (page: OrderListPage): Promise<void> => emitPage(page, page.rows)
    : undefined;
  const hotRows = hotFetchSize === 0
    ? { rows: [], totalRows: tiktokTotal }
    : await fetchOrderListRows(state, 'orders', {
      startOffset: direction === 'asc' ? Math.max(0, tiktokTotal - hotWindowSize) : 0,
      maxRows: hotFetchSize,
      ...(emitHot ? { onPage: emitHot } : {}),
    });
  let auditRows: OrderListRow[] = [];
  let nextAuditOffset = hotWindowSize;
  const historicalTotal = Math.max(0, tiktokTotal - hotWindowSize);
  if (historicalTotal > 0) {
    const previousOffset = Math.max(hotWindowSize, previousCheckpoint.auditOffset);
    const auditStart = hotWindowSize + ((previousOffset - hotWindowSize) % historicalTotal);
    const auditPage = await fetchOrderListRows(state, 'orders', {
      startOffset: auditStart,
      maxRows: ORDER_CHECKPOINT_AUDIT_WINDOW_SIZE,
      ...(onPage ? {
        onPage: async (page: OrderListPage) => emitPage(page, page.rows),
      } : {}),
    });
    auditRows = onPage ? [] : auditPage.rows;
    nextAuditOffset = hotWindowSize + ((auditStart - hotWindowSize + ORDER_CHECKPOINT_AUDIT_WINDOW_SIZE) % historicalTotal);
  }
  const checkpointAnchors = new Map<number, OrderListRow>();
  currentAnchors.forEach((row, position) => checkpointAnchors.set(position, row));
  if (direction === 'desc' && hotRows.rows[0]) checkpointAnchors.set(0, hotRows.rows[0]);
  // The shifted checkpoint probes already cover the head/middle/tail positions
  // in the common descending-growth case; record the current positions.
  const checkpoint = buildOrderListCheckpoint(
    tiktokTotal,
    direction,
    windowKey,
    nextAuditOffset,
    previousCheckpoint.lastExactAuditAt,
    checkpointAnchors,
  );
  const selectedRows = [...new Map([...hotRows.rows, ...auditRows].map((row) => [row.orderId, row])).values()];
  return {
    rows: streamedPageSeen ? [] : selectedRows,
    strategy: 'incremental',
    reconcileStatus: reconcileState ? 'passed' : 'unavailable',
    serverTotal: reconcileState?.serverTotal ?? null,
    nextAuditOffset,
    checkpoint,
    ...(streamedPageSeen ? { streamed: true } : {}),
  };
}


async function fetchLogisticsRowsForRound(
  state: OrderSyncState,
  settings: OrderApiSettings,
  scope: OrderSyncScope,
): Promise<LogisticsRoundSelection | null> {
  const rows = new Map<string, OrderListRow>();
  let terminalSkipped = 0;
  let sawReconcileItem = false;
  const orderProgress = state.orderProgress?.domains.orders;
  const ordersStillDraining = Boolean(orderProgress
    && (orderProgress.listPhase === 'list_fetching'
      || (orderProgress.pending ?? 0) > 0
      || orderProgress.currentOrderId != null
      || orderProgress.resumeOrderId != null
      || (orderProgress.failedOrderIds?.length ?? 0) > 0));
  let cursor: string | undefined;
  for (let page = 0; page < ORDER_RECONCILE_MAX_LOGISTICS_PAGES; page += 1) {
    if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('logistics', state)) {
      throw new StopOrderDomainBatch('订单同步作用域已变化，停止继续读取物流候选。');
    }
    const result = await fetchOrderReconciliation(state, settings, scope, 'logistics', cursor);
    const logistics = result?.logistics;
    if (!logistics) return null;
    sawReconcileItem ||= logistics.items.length > 0;
    for (const item of logistics.items) {
      if (item.isTerminal) {
        terminalSkipped += 1;
        continue;
      }
      rows.set(item.orderId, { orderId: item.orderId, row: {}, status: 200 });
    }
    const nextCursor = logistics.nextCursor ?? undefined;
    if (!nextCursor) {
      if (!logistics.complete) return null;
      // During the initial order drain the backend can legitimately have no
      // order rows yet. Do not mark logistics complete in that transient
      // state; let the caller discover the current TikTok order list instead.
      // If items were returned and all are terminal, keep the skip decision.
      if (!sawReconcileItem && ordersStillDraining) return null;
      return {
        rows: [...rows.values()],
        strategy: 'incremental',
        reconcileStatus: 'passed',
        terminalSkipped,
      };
    }
    if (nextCursor === cursor) return null;
    cursor = nextCursor;
    // The same reconcile endpoint is cursor-paginated. Reissue the request
    // through the shared helper below with the cursor on the next iteration.
  }
  return null;
}


/** 拉一页订单列表，返回 (orderId, 原始行)。 */
async function fetchOrderListRows(
  state: OrderSyncState,
  domain: 'orders' | 'logistics' | 'order_details' | 'order_history' = 'orders',
  options: OrderListFetchOptions = {},
): Promise<OrderListFetchResult> {
  const boundTab = state.boundTab!;
  const origin = boundSellerCenterOrigin(boundTab.url);
  const rows: Array<{ orderId: string; row: Record<string, unknown>; status: number }> = [];
  const startOffset = Math.max(0, Math.floor(options.startOffset ?? 0));
  const startPage = Math.floor(startOffset / ORDER_LIST_PAGE_SIZE) + 1;
  let offset = startOffset;
  // TikTok may keep request `offset` at the original value while advancing a
  // cursor. Checkpoint/hot-window classification needs the logical position
  // in the concatenated list, which is independent from that request detail.
  let logicalOffset = startOffset;
  let searchCursor = '';
  let paginationType = 0;
  let hasMore = true;
  let listPageCount: number | null = null;
  let totalRowsSeen: number | null = null;
  let fetchedRows = 0;
  const seenOrderIds = new Set<string>();
  const collectRows = options.onPage === undefined;
  await recordOrderProgress(domain, {
    listPhase: 'list_fetching',
    listPage: startPage,
    listPageCount: null,
    listRowsFetched: 0,
    listTotalRows: null,
    listOffset: startOffset,
    listSearchCursor: null,
    listPaginationType: 0,
  }, 'running', state, `${domain === 'orders' ? '订单' : '物流关联订单'}列表读取开始。`, {
    action: 'list_fetch_started',
    page: startPage,
  });
  for (let page = 0; page < MAX_ORDER_LIST_PAGES; page += 1) {
    if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent(domain, state)) {
      throw new StopOrderDomainBatch('订单同步作用域已变化，停止继续读取订单列表。');
    }
    const displayPage = startPage + page;
    if (page > 0) {
      await recordOrderProgress(domain, {
        listPhase: 'list_fetching',
        listPage: displayPage,
        listPageCount,
        listOffset: offset,
        listSearchCursor: searchCursor,
        listPaginationType: paginationType,
      }, 'running', state, `正在读取${domain === 'orders' ? '订单' : '物流关联订单'}列表：第 ${page + 1} 页${listPageCount ? ` / 约 ${listPageCount} 页` : ''}。`, {
        action: 'list_page_started',
        page: displayPage,
        pageCount: listPageCount,
      });
    }
    const url = tiktokOrderEndpointUrl(origin, 'order-list', {
    sellerId: boundTab.sellerId!,
    });
    const body = createOrderListRequestBody({ offset, count: ORDER_LIST_PAGE_SIZE, searchCursor, paginationType });
    const requestStartedAt = Date.now();
    let result: BoundTikTokResponse;
    try {
      result = await executeTikTokRequestWithTimeout(boundTab.tabId, url, body, 'POST');
    } catch (error) {
      await recordOrderSyncRuntimeLog(domain, 'tiktok_request', 'failed', '订单列表请求异常。', {
        stage: 'order_list',
        method: 'POST',
        endpoint: orderTikTokEndpointPath(url),
        page: displayPage,
        offset,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('POST', url, body),
        ...orderRequestExceptionDetails(error),
      });
      throw error;
    }
    if (!result.ok) {
      await recordOrderSyncRuntimeLog(domain, 'tiktok_request', 'failed', '订单列表响应失败。', {
        stage: 'order_list',
        method: 'POST',
        endpoint: orderTikTokEndpointPath(url),
        page: displayPage,
        offset,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('POST', url, body, result),
        ...orderTikTokResponseDiagnostics(result),
      });
      if (isTikTokAuthenticationFailure(result)) await clearOrderBinding(state, 'order_authentication_failed');
      throw new Error(orderTikTokFailureSummary('订单列表请求失败', result));
    }
    if (isTikTokAuthenticationFailure(result)) {
      await recordOrderSyncRuntimeLog(domain, 'tiktok_request', 'failed', '订单列表响应要求重新登录。', {
        stage: 'order_list',
        method: 'POST',
        endpoint: orderTikTokEndpointPath(url),
        page: page + 1,
        offset,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        failureReason: 'authentication_required',
        ...orderTikTokRuntimeExchange('POST', url, body, result),
        ...orderTikTokResponseDiagnostics(result),
      });
      await clearOrderBinding(state, 'order_authentication_failed');
      throw new Error('订单列表请求需要重新登录。');
    }
    const payload = isRecord(result.payload) ? result.payload : {};
    const businessFailure = tiktokBusinessFailure(payload, '订单列表');
    if (businessFailure) {
      await recordOrderSyncRuntimeLog(domain, 'tiktok_request', 'failed', '订单列表业务响应失败。', {
        stage: 'order_list',
        method: 'POST',
        endpoint: orderTikTokEndpointPath(url),
        page: displayPage,
        offset,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        failureReason: 'business_code',
        ...orderTikTokRuntimeExchange('POST', url, body, result),
        ...orderTikTokResponseDiagnostics(result),
      });
      throw new Error(businessFailure);
    }
    const data = isRecord(payload.data) ? payload.data : {};
    const list = Array.isArray(data.main_orders) ? data.main_orders : [];
    await recordOrderSyncRuntimeLog(domain, 'tiktok_request', 'succeeded', '订单列表响应已解析。', {
      stage: 'order_list',
      method: 'POST',
      endpoint: orderTikTokEndpointPath(url),
      page: displayPage,
      offset,
      rowCount: list.filter(isRecord).length,
      hasMore: data.has_more === true || data.search_next_has_more === true,
      durationMs: Math.max(0, Date.now() - requestStartedAt),
      ...orderTikTokRuntimeExchange('POST', url, body, result),
      ...orderTikTokResponseDiagnostics(result),
    });
    const rawPageRows = [...new Map(list
      .filter(isRecord)
      // §2.5 dumps 契约：每条 row 的 dump 必须带真实上游 HTTP 状态（result.status），
      // 不能再硬编码 200。否则分页里任何 2xx 异常都会被服务端当正常数据 ingest。
      .map((row) => ({ orderId: String(row.main_order_id ?? ''), row, status: result.status }))
      .filter((entry) => entry.orderId.length > 0)
      .map((entry) => [entry.orderId, { orderId: entry.orderId, row: entry.row, status: entry.status }] as const)).values()];
    const pageRows = rawPageRows
      .filter((entry) => !seenOrderIds.has(entry.orderId))
      .slice(0, options.maxRows === undefined ? undefined : Math.max(0, options.maxRows - fetchedRows));
    pageRows.forEach((entry) => seenOrderIds.add(entry.orderId));
    if (collectRows) rows.push(...pageRows);
    fetchedRows += pageRows.length;
    const rawTotalRows = Number(data.total_count);
    const totalRows = Number.isFinite(rawTotalRows) ? Math.max(0, rawTotalRows) : null;
    totalRowsSeen = totalRows;
    const pageCount = totalRows === null
      ? null
      : Math.max(1, Math.ceil(totalRows / ORDER_LIST_PAGE_SIZE));
    listPageCount = pageCount;
    await recordOrderProgress(domain, {
      listPhase: 'list_fetching',
      listPage: displayPage,
      listPageCount: pageCount,
      listRowsFetched: collectRows ? rows.length : startOffset + fetchedRows,
      listTotalRows: totalRows,
      listOffset: offset,
      listSearchCursor: searchCursor,
      listPaginationType: paginationType,
      }, 'running', state, `正在读取${domain === 'orders' ? '订单' : '物流关联订单'}列表：第 ${displayPage} 页${pageCount ? ` / 约 ${pageCount} 页` : ''}。`, {
      action: 'list_page_fetched',
      page: displayPage,
      pageCount,
       fetchedRows: collectRows ? rows.length : startOffset + fetchedRows,
       totalRows,
     });
    hasMore = data.has_more === true || data.search_next_has_more === true;
    const reachedMaxRows = options.maxRows !== undefined && fetchedRows >= options.maxRows;
    if (reachedMaxRows) hasMore = false;
    if (options.onPage !== undefined) {
      await options.onPage({
        rows: pageRows,
        page: displayPage,
        pageCount,
        fetchedRows: startOffset + fetchedRows,
        totalRows,
        requestOffset: offset,
        logicalOffset,
        searchCursor,
        paginationType,
        hasMore,
      });
    }
    if (reachedMaxRows) break;
    if (!hasMore || list.length === 0) break;
    logicalOffset += pageRows.length;
    const nextCursor = typeof data.next_cursor_token === 'string'
      ? data.next_cursor_token
      : typeof data.search_next_cursor === 'string' ? data.search_next_cursor : '';
    if (nextCursor && nextCursor !== searchCursor) {
      searchCursor = nextCursor;
      paginationType = 1;
    } else {
      offset += list.length;
    }
  }
  if (hasMore) throw new Error('订单列表分页超过安全上限。');
  // Seller Center 分页偶尔会在游标边界重复返回一单；订单域的同步单元是
  // mainOrderId，去重后再上传，避免分页边界重复行放大进度和请求量。
  const uniqueRows = [...new Map(rows.map((row) => [row.orderId, row])).values()];
  return {
    rows: options.onPage !== undefined
      ? []
      : options.maxRows === undefined ? uniqueRows : uniqueRows.slice(0, Math.max(0, options.maxRows)),
    totalRows: totalRowsSeen,
  };
}


type OrderDomainBatchEntry = {
  key: string;
  displayId: string;
  index: number;
  process: () => Promise<void>;
};


type OrderDomainBatchOptions = {
  /** Aggregate progress values when a caller streams multiple list pages. */
  total?: number;
  covered?: number;
  uploadedBefore?: number;
  pendingAfterPage?: number;
  /** Failed items from earlier streamed pages must remain resumable. */
  preservedFailedOrderIds?: string[];
  /** Do not create a continuation alarm for every streamed page. */
  scheduleContinuation?: boolean;
};


type LogisticsBatchOptions = {
  total?: number;
  uploadedBefore?: number;
  pendingAfterPage?: number;
  /** Failed items from earlier streamed pages must remain resumable. */
  preservedFailedOrderIds?: string[];
  scheduleContinuation?: boolean;
};


class StopOrderDomainBatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StopOrderDomainBatch';
  }
}


function continuationAlarmForOrderDomain(domain: OrderPollingDomain): string {
  if (domain === 'orders') return ORDER_CONTINUATION_ALARM;
  if (domain === 'logistics') return LOGISTICS_CONTINUATION_ALARM;
  if (domain === 'order_details') return ORDER_DETAILS_CONTINUATION_ALARM;
  if (domain === 'order_history') return ORDER_HISTORY_CONTINUATION_ALARM;
  return SETTLEMENT_CONTINUATION_ALARM;
}


async function deferOrderDomainAlarm(domain: OrderPollingDomain): Promise<void> {
  // Continuations already provide a nearer retry; otherwise preserve the
  // one-shot automatic run instead of losing it when another domain owns the lane.
  const continuation = await chrome.alarms.get(continuationAlarmForOrderDomain(domain));
  if (continuation) return;
  const alarm = domain === 'orders' ? ORDER_SYNC_ALARM
    : domain === 'logistics' ? LOGISTICS_SYNC_ALARM
    : domain === 'order_details' ? ORDER_DETAILS_SYNC_ALARM
    : domain === 'order_history' ? ORDER_HISTORY_SYNC_ALARM
    : SETTLEMENT_SYNC_ALARM;
  await chrome.alarms.create(alarm, { delayInMinutes: ORDER_DOMAIN_BUSY_RETRY_DELAY_MINUTES });
}


function cycleDelayForOrderDomain(domain: OrderPollingDomain): number {
  if (domain === 'orders') return ORDER_SYNC_NEXT_DELAY_MINUTES;
  if (domain === 'logistics') return LOGISTICS_SYNC_NEXT_DELAY_MINUTES;
  if (domain === 'order_details') return ORDER_DETAILS_SYNC_NEXT_DELAY_MINUTES;
  if (domain === 'order_history') return ORDER_HISTORY_SYNC_NEXT_DELAY_MINUTES;
  return SETTLEMENT_SYNC_NEXT_DELAY_MINUTES;
}


function isOrderDomainRoundSettled(row: OrderDomainProgressRow | undefined): boolean {
  return Boolean(row
    && row.pending === 0
    && row.currentOrderId == null
    && row.resumeOrderId == null
    && (row.failedOrderIds?.length ?? 0) === 0
    && row.lastError == null);
}


function shouldScheduleNextOrderDomainRound(row: OrderDomainProgressRow | undefined): boolean {
  if (isOrderDomainRoundSettled(row)) return true;
  // 列表为空/列表请求失败时没有批次 continuation；保留错误并安排下一轮，
  // 让后续轮询继续验证 Seller Center 是否恢复。
  return Boolean(row
    && row.lastError
    && row.currentOrderId == null
    && row.resumeOrderId == null
    && (row.failedOrderIds?.length ?? 0) === 0);
}


async function scheduleNextOrderDomainRound(domain: OrderPollingDomain): Promise<void> {
  const nextSyncAt = new Date(Date.now() + cycleDelayForOrderDomain(domain) * 60_000).toISOString();
  await orderSyncStateStore.update((current) => {
    const base = current.orderProgress ?? createDefaultOrderProgress();
    return {
      ...current,
      orderProgress: {
        ...base,
        domains: { ...base.domains, [domain]: { ...base.domains[domain], nextSyncAt } },
      },
    };
  });
  if (domain === 'orders') {
    await chrome.alarms.create(ORDER_SYNC_ALARM, {
      delayInMinutes: cycleDelayForOrderDomain(domain),
    });
  } else if (domain === 'logistics') {
    await chrome.alarms.create(LOGISTICS_SYNC_ALARM, {
      delayInMinutes: cycleDelayForOrderDomain(domain),
    });
  } else if (domain === 'order_details') {
    await chrome.alarms.create(ORDER_DETAILS_SYNC_ALARM, {
      delayInMinutes: cycleDelayForOrderDomain(domain),
    });
  } else if (domain === 'order_history') {
    await chrome.alarms.create(ORDER_HISTORY_SYNC_ALARM, {
      delayInMinutes: cycleDelayForOrderDomain(domain),
    });
  } else {
    await chrome.alarms.create(SETTLEMENT_SYNC_ALARM, {
      delayInMinutes: cycleDelayForOrderDomain(domain),
    });
  }
}


async function scheduleOrderDomainRetryAfterListFailure(
  domain: OrderPollingDomain,
  expectedState: OrderSyncState,
): Promise<void> {
  if (!await isOrderSyncScopeCurrent(expectedState)) return;
  const continuation = continuationAlarmForOrderDomain(domain);
  if (typeof chrome.alarms.clear === 'function') await chrome.alarms.clear(continuation);
  await scheduleNextOrderDomainRound(domain);
}


async function scheduleOrderDomainContinuation(
  domain: Exclude<OrderPollingDomain, 'logistics'>,
  completed: boolean,
  stopped: boolean,
): Promise<void> {
  const alarm = continuationAlarmForOrderDomain(domain);
  if (completed || stopped) {
    if (typeof chrome.alarms.clear === 'function') await chrome.alarms.clear(alarm);
    return;
  }
  if (domain === 'orders') {
    await chrome.alarms.create(ORDER_CONTINUATION_ALARM, {
      delayInMinutes: ORDER_DOMAIN_CONTINUATION_DELAY_MINUTES,
    });
  } else if (domain === 'order_details') {
    await chrome.alarms.create(ORDER_DETAILS_CONTINUATION_ALARM, {
      delayInMinutes: ORDER_DOMAIN_CONTINUATION_DELAY_MINUTES,
    });
  } else if (domain === 'order_history') {
    await chrome.alarms.create(ORDER_HISTORY_CONTINUATION_ALARM, {
      delayInMinutes: ORDER_DOMAIN_CONTINUATION_DELAY_MINUTES,
    });
  } else {
    await chrome.alarms.create(SETTLEMENT_CONTINUATION_ALARM, {
      delayInMinutes: ORDER_DOMAIN_CONTINUATION_DELAY_MINUTES,
    });
  }
}


function uniqueOrderDomainKeys(keys: readonly string[], available: Set<string>): string[] {
  return [...new Set(keys)].filter((key) => available.has(key));
}


/**
 * 计算当前轮次的待处理队列。新版本直接使用 pendingOrderIds；旧版本只有
 * snapshot + resumeOrderId 时按旧游标恢复，并把快照之外的新条目追加到队尾。
 */
function pendingOrderDomainKeys(
  previous: OrderDomainProgressRow,
  entries: readonly { key: string }[],
): string[] {
  const keys = entries.map((entry) => entry.key);
  const available = new Set(keys);
  const previousSnapshot = new Set(previous.snapshotKeys ?? []);
  const newKeys = keys.filter((key) => !previousSnapshot.has(key));
  if ((previous.pendingOrderIds?.length ?? 0) > 0) {
    return uniqueOrderDomainKeys([...(previous.pendingOrderIds ?? []), ...newKeys], available);
  }

  const failedKeys = uniqueOrderDomainKeys(previous.failedOrderIds ?? [], available);
  const resumeKey = previous.resumeOrderId ?? previous.currentOrderId ?? null;
  if (resumeKey !== null) {
    const snapshot = previous.snapshotKeys ?? [];
    const resumeIndex = snapshot.indexOf(resumeKey);
    const oldPending = resumeIndex >= 0
      ? snapshot.slice(resumeIndex)
      : keys;
    return uniqueOrderDomainKeys([...oldPending, ...failedKeys, ...newKeys], available);
  }
  if (failedKeys.length > 0) {
    return uniqueOrderDomainKeys([
      ...keys.filter((key) => !failedKeys.includes(key)),
      ...failedKeys,
      ...newKeys,
    ], available);
  }
  // A legacy state with a positive numeric pending count but no durable queue
  // cannot identify the exact successful rows safely; replay the current list.
  return keys;
}


/**
 * 订单/结算批次通用处理器：每个条目成功、失败、开始时都持久化待处理队列，
 * 下一次 continuation alarm 或插件重启从同一队列继续。失败项移到队尾，
 * 确保一组持续失败的订单不会阻塞后面的订单。
 */
async function processOrderDomainBatch(
  state: OrderSyncState,
  domain: Exclude<OrderPollingDomain, 'logistics'>,
  entries: OrderDomainBatchEntry[],
  covered: number,
  delayBetweenItemsMs = 0,
  initialError: string | null = null,
  options: OrderDomainBatchOptions = {},
): Promise<void> {
  const previous = state.orderProgress?.domains[domain] ?? createDefaultOrderProgress().domains[domain];
  const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const pendingKeys = pendingOrderDomainKeys(previous, entries);
  const preservedFailedKeys = new Set(options.preservedFailedOrderIds ?? []);
  const failedKeys = new Set([
    ...(previous.failedOrderIds ?? []).filter((key) => pendingKeys.includes(key)),
    ...preservedFailedKeys,
  ]);
  let lastError = initialError ?? (pendingKeys.length > 0 ? previous.lastError : null);
  const batch = pendingKeys.slice(0, ORDER_DOMAIN_BATCH_SIZE)
    .map((key) => entryByKey.get(key))
    .filter((entry): entry is OrderDomainBatchEntry => entry !== undefined);
  const progressTotal = Math.max(entries.length, options.total ?? entries.length);
  const progressCovered = Math.max(0, options.covered ?? covered);
  const uploadedBefore = Math.max(0, options.uploadedBefore ?? 0);
  const pendingAfterPage = Math.max(0, options.pendingAfterPage ?? 0);
  const pagePending = () => pendingAfterPage + new Set([...preservedFailedKeys, ...pendingKeys]).size;
  let uploaded = uploadedBefore + Math.max(0, entries.length - pendingKeys.length);
  const pendingSnapshot = () => [...new Set([...preservedFailedKeys, ...pendingKeys])];
  const failedSnapshot = () => [...failedKeys];
  const resumeKey = () => pendingKeys[0] ?? null;

  if (batch.length === 0) {
    await recordOrderProgress(domain, {
      total: progressTotal,
      covered: progressCovered,
      uploaded,
      pending: pagePending(),
      failed: failedSnapshot().length,
      currentOrderId: null,
      currentOrderIndex: null,
      resumeOrderId: resumeKey(),
      failedOrderIds: failedSnapshot(),
      snapshotKeys: entries.map((entry) => entry.key),
      pendingOrderIds: pendingSnapshot(),
      lastError: pagePending() > 0 ? lastError : null,
      ...resetOrderListProgress(),
    }, pagePending() > 0 ? 'running' : 'ok', state,
    pagePending() > 0 ? `${domain} 批次等待条目重试。` : `${domain} 本轮已完成。`, {
      action: pagePending() > 0 ? 'batch_waiting_retry' : 'batch_completed',
      batchSize: 0,
    });
    if (options.scheduleContinuation !== false) {
      await scheduleOrderDomainContinuation(domain, pagePending() === 0, false);
    }
    return;
  }

  await recordOrderProgress(domain, {
    total: progressTotal,
    covered: progressCovered,
    uploaded,
    pending: pagePending(),
    failed: failedSnapshot().length,
    currentOrderId: null,
    currentOrderIndex: null,
    resumeOrderId: resumeKey(),
    failedOrderIds: failedSnapshot(),
    snapshotKeys: entries.map((entry) => entry.key),
    pendingOrderIds: pendingSnapshot(),
    lastError,
    listPhase: 'processing',
  }, 'running', state, `${domain} 批次开始：本轮处理 ${batch.length} 条。`, {
    action: 'batch_started',
    batchSize: batch.length,
    resumeOrderId: resumeKey(),
  });

  let stopped = false;
  for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
    const entry = batch[batchIndex]!;
    const itemStartedAt = Date.now();
    await recordOrderProgress(domain, {
      total: progressTotal,
      covered: progressCovered,
      uploaded,
      pending: pagePending(),
      failed: failedSnapshot().length,
      currentOrderId: entry.displayId,
      currentOrderIndex: entry.index,
      resumeOrderId: resumeKey(),
      failedOrderIds: failedSnapshot(),
      pendingOrderIds: pendingSnapshot(),
      lastError,
    }, 'running', state, `${domain} 开始处理：${entry.displayId}`, {
      action: 'order_started',
      orderId: entry.displayId,
      orderIndex: entry.index,
      batchIndex: batchIndex + 1,
      batchSize: batch.length,
    });

    try {
      if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent(domain, state)) {
        stopped = true;
        break;
      }
      await entry.process();
      await recordOrderSyncRuntimeLog(domain, 'item_succeeded', 'succeeded', `${domain} 条目处理成功。`, {
        stage: 'item_process',
        itemId: entry.displayId,
        durationMs: Math.max(0, Date.now() - itemStartedAt),
      });
      const pendingIndex = pendingKeys.indexOf(entry.key);
      if (pendingIndex >= 0) pendingKeys.splice(pendingIndex, 1);
      uploaded = uploadedBefore + Math.max(0, entries.length - pendingKeys.length);
      preservedFailedKeys.delete(entry.key);
      failedKeys.delete(entry.key);
      lastError = failedKeys.size > 0 ? lastError : null;
      await recordOrderProgress(domain, {
        total: progressTotal,
        covered: progressCovered,
        uploaded,
        pending: pagePending(),
        failed: failedSnapshot().length,
        currentOrderId: null,
        currentOrderIndex: null,
        resumeOrderId: resumeKey(),
        failedOrderIds: failedSnapshot(),
        pendingOrderIds: pendingSnapshot(),
        lastSuccessAt: new Date().toISOString(),
        lastError,
      }, 'running', state, `${domain} 同步成功：${entry.displayId}`, {
        action: 'order_succeeded',
        orderId: entry.displayId,
        orderIndex: entry.index,
      });
    } catch (error) {
      if (error instanceof StopOrderDomainBatch) {
        stopped = true;
        lastError = error.message;
        break;
      }
      lastError = error instanceof Error ? error.message : String(error);
      await recordOrderSyncRuntimeLog(domain, 'item_failed', 'failed', `${domain} 条目处理失败。`, {
        stage: 'item_process',
        itemId: entry.displayId,
        durationMs: Math.max(0, Date.now() - itemStartedAt),
        ...orderRequestExceptionDetails(error),
      });
      failedKeys.add(entry.key);
      const pendingIndex = pendingKeys.indexOf(entry.key);
      if (pendingIndex >= 0) {
        pendingKeys.splice(pendingIndex, 1);
        pendingKeys.push(entry.key);
      } else {
        pendingKeys.push(entry.key);
      }
      await recordOrderProgress(domain, {
        total: progressTotal,
        covered: progressCovered,
        uploaded,
        pending: pagePending(),
        failed: failedSnapshot().length,
        currentOrderId: null,
        currentOrderIndex: null,
        resumeOrderId: resumeKey(),
        failedOrderIds: failedSnapshot(),
        pendingOrderIds: pendingSnapshot(),
        lastFailedOrderId: entry.displayId,
        lastError,
      }, 'running', state, `${domain} 条目失败：${entry.displayId}（${lastError}）`, {
        action: 'order_failed',
        orderId: entry.displayId,
        orderIndex: entry.index,
        error: sanitizeDiagnosticText(lastError).slice(0, 240),
        ...orderRequestExceptionDetails(error),
      });
    }

    if (!stopped && delayBetweenItemsMs > 0 && batchIndex < batch.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayBetweenItemsMs));
    }
  }

  const completed = !stopped && pendingKeys.length === 0 && failedKeys.size === 0 && pendingAfterPage === 0;
  await recordOrderProgress(domain, {
    total: progressTotal,
    covered: progressCovered,
    uploaded,
    pending: pagePending(),
    failed: failedSnapshot().length,
    currentOrderId: null,
    currentOrderIndex: null,
    resumeOrderId: resumeKey(),
    failedOrderIds: failedSnapshot(),
    pendingOrderIds: pendingSnapshot(),
    lastError: pagePending() > 0 ? lastError : null,
    ...resetOrderListProgress(),
  }, completed ? 'ok' : 'running', state,
  completed
    ? `${domain} 批次完成：本轮全部条目已同步。`
     : `${domain} 批次完成：成功 ${uploaded} 条，待处理 ${pagePending()} 条。`, {
    action: completed ? 'batch_completed' : 'batch_checkpointed',
    batchSize: batch.length,
    uploaded,
    failed: failedSnapshot().length,
    resumeOrderId: resumeKey(),
  });
  if (options.scheduleContinuation !== false) {
    await scheduleOrderDomainContinuation(domain, completed, stopped);
  }
}


/**
 * 物流详情采用可恢复批处理：每轮最多处理 LOGISTICS_BATCH_SIZE 单，
 * 成功数、失败队列、当前订单和下一游标均在每次尝试后落盘。
 */
async function processLogisticsBatch(
  state: OrderSyncState,
  settings: OrderApiSettings,
  scope: OrderSyncScope,
  boundTab: NonNullable<OrderSyncState['boundTab']>,
  origin: string,
  rows: Array<{ orderId: string; row: Record<string, unknown>; status: number }>,
  terminalSkipped = 0,
  options: LogisticsBatchOptions = {},
): Promise<void> {
  const previous = state.orderProgress?.domains.logistics ?? createDefaultOrderProgress().domains.logistics;
  const activeRows = rows.filter((entry) => !isCancelledTikTokOrderRow(entry.row));
  const cancelledSkipped = rows.length - activeRows.length;
  // 订单、物流、结算共用总状态字段；恢复物流时只读取 logistics 自己的队列。
  const pendingKeys = pendingOrderDomainKeys(previous, activeRows.map((entry) => ({ key: entry.orderId })));
  const entryById = new Map(activeRows.map((entry) => [entry.orderId, entry]));
  const preservedFailedIds = new Set(options.preservedFailedOrderIds ?? []);
  const failedIds = new Set([
    ...(previous.failedOrderIds ?? []).filter((key) => pendingKeys.includes(key)),
    ...preservedFailedIds,
  ]);
  let lastError = previous.lastError;
  const terminalCount = Math.max(0, terminalSkipped) + cancelledSkipped;
  const roundTotal = activeRows.length + terminalCount;
  const progressTotal = Math.max(roundTotal, options.total ?? roundTotal);
  const uploadedBefore = Math.max(0, options.uploadedBefore ?? 0);
  const pendingAfterPage = Math.max(0, options.pendingAfterPage ?? 0);
  const pagePending = () => pendingAfterPage + new Set([...preservedFailedIds, ...pendingKeys]).size;
  let uploaded = uploadedBefore + terminalCount + Math.max(0, activeRows.length - pendingKeys.length);
  const batch = pendingKeys.slice(0, LOGISTICS_BATCH_SIZE)
    .map((orderId) => entryById.get(orderId))
    .filter((entry): entry is (typeof rows)[number] => entry !== undefined);
  const pendingSnapshot = () => [...new Set([...preservedFailedIds, ...pendingKeys])];
  const failedSnapshot = () => [...failedIds];
  const resumeOrderId = () => pendingKeys[0] ?? null;

  if (batch.length === 0) {
    await recordOrderProgress('logistics', {
      total: progressTotal,
      uploaded,
      pending: pagePending(),
      failed: failedSnapshot().length,
      currentOrderId: null,
      currentOrderIndex: null,
      resumeOrderId: resumeOrderId(),
      failedOrderIds: failedSnapshot(),
      snapshotKeys: rows.map((entry) => entry.orderId),
      pendingOrderIds: pendingSnapshot(),
      lastError: pagePending() > 0 ? lastError : null,
      ...resetOrderListProgress(),
    }, pendingKeys.length > 0 ? 'running' : 'ok', state,
    pendingKeys.length > 0 ? '物流批次等待订单重试。' : '物流本轮已完成。', {
      action: pendingKeys.length > 0 ? 'batch_waiting_retry' : 'batch_completed',
      batchSize: 0,
    });
    return;
  }

  await recordOrderProgress('logistics', {
    total: progressTotal,
    uploaded,
    pending: pagePending(),
    failed: failedSnapshot().length,
    currentOrderId: null,
    currentOrderIndex: null,
    resumeOrderId: resumeOrderId(),
    failedOrderIds: failedSnapshot(),
    snapshotKeys: rows.map((entry) => entry.orderId),
    pendingOrderIds: pendingSnapshot(),
    lastError,
    listPhase: 'processing',
  }, 'running', state, `物流批次开始：本轮处理 ${batch.length} 单。`, {
    action: 'batch_started',
    batchSize: batch.length,
    resumeOrderId: resumeOrderId(),
  });

  let stopped = false;
  for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
    const pendingRow = batch[batchIndex]!;
    const orderId = pendingRow.orderId;
    const orderIndex = rows.findIndex((entry) => entry.orderId === orderId);
    await recordOrderProgress('logistics', {
      total: progressTotal,
      uploaded,
      pending: pagePending(),
      failed: failedSnapshot().length,
      currentOrderId: orderId,
      currentOrderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
      resumeOrderId: resumeOrderId(),
      failedOrderIds: failedSnapshot(),
      pendingOrderIds: pendingSnapshot(),
      lastError,
    }, 'running', state, `物流开始处理订单：${orderId}`, {
      action: 'order_started',
      orderId,
      orderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
      batchIndex: batchIndex + 1,
      batchSize: batch.length,
    });

    let attemptError: string | null = null;
    let attemptFailure: unknown = null;
    try {
      if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('logistics', state)) {
        stopped = true;
        break;
      }
      const detailUrl = tiktokOrderEndpointUrl(
        'https://api16-normal-sg.tiktokshopglobalselling.com',
        'logistic-detail',
        { sellerId: boundTab.sellerId! },
        createLogisticDetailQuery(orderId),
      );
      const requestStartedAt = Date.now();
      let detail: BoundTikTokResponse;
      try {
        detail = await executeTikTokRequestWithTimeout(
          boundTab.tabId, detailUrl, {}, 'GET', ORDER_ITEM_REQUEST_TIMEOUT_MS,
        );
      } catch (error) {
        await recordOrderSyncRuntimeLog('logistics', 'tiktok_request', 'failed', '物流详情请求异常。', {
          stage: 'logistics_detail',
          method: 'GET',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('GET', detailUrl, undefined),
          ...orderRequestExceptionDetails(error),
        });
        throw error;
      }
      const detailPayload = isRecord(detail.payload) ? detail.payload : null;
      const detailBusinessFailure = detailPayload === null
        ? null
        : tiktokBusinessFailure(detailPayload, '物流详情');
      if (!detail.ok) {
        await recordOrderSyncRuntimeLog('logistics', 'tiktok_request', 'failed', '物流详情响应失败。', {
          stage: 'logistics_detail',
          method: 'GET',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('GET', detailUrl, undefined, detail),
          ...orderTikTokResponseDiagnostics(detail),
        });
        if (isTikTokAuthenticationFailure(detail)) {
          await clearOrderBinding(state, 'logistics_authentication_failed');
          stopped = true;
        }
        attemptError = orderTikTokFailureSummary('详情请求失败', detail);
      } else if (isTikTokAuthenticationFailure(detail)) {
        await recordOrderSyncRuntimeLog('logistics', 'tiktok_request', 'failed', '物流详情响应要求重新登录。', {
          stage: 'logistics_detail',
          method: 'GET',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          failureReason: 'authentication_required',
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('GET', detailUrl, undefined, detail),
          ...orderTikTokResponseDiagnostics(detail),
        });
        await clearOrderBinding(state, 'logistics_authentication_failed');
        stopped = true;
        attemptError = '物流详情请求需要重新登录。';
      } else if (detailPayload === null) {
        await recordOrderSyncRuntimeLog('logistics', 'tiktok_request', 'failed', '物流详情响应为空。', {
          stage: 'logistics_detail',
          method: 'GET',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          failureReason: 'empty_payload',
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('GET', detailUrl, undefined, detail),
          ...orderTikTokResponseDiagnostics(detail),
        });
        attemptError = `物流详情响应为空（${nullPayloadDiagnostic(detail)}）`;
      } else if (detailBusinessFailure !== null) {
        await recordOrderSyncRuntimeLog('logistics', 'tiktok_request', 'failed', '物流详情业务响应失败。', {
          stage: 'logistics_detail',
          method: 'GET',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          failureReason: 'business_code',
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('GET', detailUrl, undefined, detail),
          ...orderTikTokResponseDiagnostics(detail),
        });
        attemptError = detailBusinessFailure;
      } else {
        await recordOrderSyncRuntimeLog('logistics', 'tiktok_request', 'succeeded', '物流详情响应已解析。', {
          stage: 'logistics_detail',
          method: 'GET',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('GET', detailUrl, undefined, detail),
          ...orderTikTokResponseDiagnostics(detail),
        });
        if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('logistics', state)) {
          stopped = true;
          break;
        }
        const uploadStartedAt = Date.now();
        try {
          await uploadOrderSyncDumpGuarded(settings, scope, createOrderSyncDump({
            domain: 'logistics',
            endpoint: detailUrl,
            method: 'GET',
            request: {},
            response: { status: detail.status, body: detailPayload },
            createdAt: new Date().toISOString(),
            mainOrderId: orderId,
          }));
          await recordOrderSyncRuntimeLog('logistics', 'erp_upload', 'succeeded', '物流详情已写入 ERP。', {
            stage: 'tts_erp_upload',
            orderId,
            endpoint: orderTikTokEndpointPath(detailUrl),
            durationMs: Math.max(0, Date.now() - uploadStartedAt),
          });
        } catch (error) {
          await recordOrderSyncRuntimeLog('logistics', 'erp_upload', 'failed', '物流详情写入 ERP 失败。', {
            stage: 'tts_erp_upload',
            orderId,
            endpoint: orderTikTokEndpointPath(detailUrl),
            durationMs: Math.max(0, Date.now() - uploadStartedAt),
            ...orderRequestExceptionDetails(error),
          });
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof StopOrderDomainBatch) {
        stopped = true;
        break;
      }
      attemptFailure = error;
      attemptError = error instanceof Error ? error.message : String(error);
    }

    if (attemptError !== null) {
      failedIds.add(orderId);
      lastError = attemptError;
      const pendingIndex = pendingKeys.indexOf(orderId);
      if (pendingIndex >= 0) {
        pendingKeys.splice(pendingIndex, 1);
        pendingKeys.push(orderId);
      } else {
        pendingKeys.push(orderId);
      }
      await recordOrderProgress('logistics', {
        total: progressTotal,
        uploaded,
        pending: pagePending(),
        failed: failedSnapshot().length,
        currentOrderId: null,
        currentOrderIndex: null,
        resumeOrderId: resumeOrderId(),
        failedOrderIds: failedSnapshot(),
        pendingOrderIds: pendingSnapshot(),
        lastFailedOrderId: orderId,
        lastError,
      }, 'running', state, `物流订单失败：${orderId}（${attemptError}）`, {
        action: 'order_failed',
        orderId,
        orderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
        error: sanitizeDiagnosticText(attemptError).slice(0, 240),
        ...orderRequestExceptionDetails(attemptFailure),
      });
    } else {
      const pendingIndex = pendingKeys.indexOf(orderId);
      if (pendingIndex >= 0) pendingKeys.splice(pendingIndex, 1);
      uploaded = uploadedBefore + terminalCount + Math.max(0, activeRows.length - pendingKeys.length);
      preservedFailedIds.delete(orderId);
      failedIds.delete(orderId);
      lastError = failedIds.size > 0 ? lastError : null;
      await recordOrderProgress('logistics', {
        total: progressTotal,
        uploaded,
        pending: pagePending(),
        failed: failedSnapshot().length,
        currentOrderId: null,
        currentOrderIndex: null,
        resumeOrderId: resumeOrderId(),
        failedOrderIds: failedSnapshot(),
        pendingOrderIds: pendingSnapshot(),
        lastSuccessAt: new Date().toISOString(),
        lastError,
      }, 'running', state, `物流订单同步成功：${orderId}`, {
        action: 'order_succeeded',
        orderId,
        orderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
      });
    }

    if (!stopped && batchIndex < batch.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, ORDER_DETAIL_FETCH_DELAY_MS));
    }
    if (stopped) break;
  }

  const completed = !stopped && pendingKeys.length === 0 && failedIds.size === 0 && pendingAfterPage === 0;
  await recordOrderProgress('logistics', {
    total: progressTotal,
    uploaded,
    pending: pagePending(),
    failed: failedSnapshot().length,
    currentOrderId: null,
    currentOrderIndex: null,
    resumeOrderId: resumeOrderId(),
    failedOrderIds: failedSnapshot(),
    pendingOrderIds: pendingSnapshot(),
    lastError: pagePending() > 0 ? lastError : null,
    ...resetOrderListProgress(),
  }, completed ? 'ok' : 'running', state,
  completed
    ? '物流批次完成：本轮全部订单已同步。'
    : `物流批次完成：成功 ${uploaded} 单，待处理 ${pagePending()} 单。`, {
    action: completed ? 'batch_completed' : 'batch_checkpointed',
    batchSize: batch.length,
    uploaded,
    failed: failedSnapshot().length,
    resumeOrderId: resumeOrderId(),
  });
  if (options.scheduleContinuation === false) return;
  if (completed) {
    if (typeof chrome.alarms.clear === 'function') await chrome.alarms.clear(LOGISTICS_CONTINUATION_ALARM);
  } else if (!stopped) {
    await chrome.alarms.create(LOGISTICS_CONTINUATION_ALARM, {
      delayInMinutes: LOGISTICS_CONTINUATION_DELAY_MINUTES,
    });
  }
}


/**
 * 订单详情（order/get）逐单请求并上传。结构与物流批次相同（N+1 模式）。
 * 每轮最多处理 LOGISTICS_BATCH_SIZE 单，游标持久化，下一轮从未完成位置继续。
 */
async function processOrderDetailsBatch(
  state: OrderSyncState,
  settings: OrderApiSettings,
  scope: OrderSyncScope,
  boundTab: NonNullable<OrderSyncState['boundTab']>,
  origin: string,
  rows: Array<{ orderId: string; row: Record<string, unknown>; status: number }>,
  terminalSkipped = 0,
  options: LogisticsBatchOptions = {},
): Promise<void> {
  const previous = state.orderProgress?.domains.order_details ?? createDefaultOrderProgress().domains.order_details;
  // Cancellation is terminal only for logistics. Details remain mutable and
  // contain refund/buyer/amount fields that still need to reach the ERP.
  const activeRows = rows;
  const pendingKeys = pendingOrderDomainKeys(previous, activeRows.map((entry) => ({ key: entry.orderId })));
  const entryById = new Map(activeRows.map((entry) => [entry.orderId, entry]));
  const preservedFailedIds = new Set(options.preservedFailedOrderIds ?? []);
  const failedIds = new Set([
    ...(previous.failedOrderIds ?? []).filter((key) => pendingKeys.includes(key)),
    ...preservedFailedIds,
  ]);
  let lastError = previous.lastError;
  const terminalCount = Math.max(0, terminalSkipped);
  const roundTotal = activeRows.length + terminalCount;
  const progressTotal = Math.max(roundTotal, options.total ?? roundTotal);
  const uploadedBefore = Math.max(0, options.uploadedBefore ?? 0);
  const pendingAfterPage = Math.max(0, options.pendingAfterPage ?? 0);
  const pagePending = () => pendingAfterPage + new Set([...preservedFailedIds, ...pendingKeys]).size;
  let uploaded = uploadedBefore + terminalCount + Math.max(0, activeRows.length - pendingKeys.length);
  const batch = pendingKeys.slice(0, LOGISTICS_BATCH_SIZE)
    .map((orderId) => entryById.get(orderId))
    .filter((entry): entry is (typeof rows)[number] => entry !== undefined);
  const pendingSnapshot = () => [...new Set([...preservedFailedIds, ...pendingKeys])];
  const failedSnapshot = () => [...failedIds];
  const resumeOrderId = () => pendingKeys[0] ?? null;

  if (batch.length === 0) {
    await recordOrderProgress('order_details', {
      total: progressTotal,
      uploaded,
      pending: pagePending(),
      failed: failedSnapshot().length,
      currentOrderId: null,
      currentOrderIndex: null,
      resumeOrderId: resumeOrderId(),
      failedOrderIds: failedSnapshot(),
      snapshotKeys: rows.map((entry) => entry.orderId),
      pendingOrderIds: pendingSnapshot(),
      lastError: pagePending() > 0 ? lastError : null,
      ...resetOrderListProgress(),
    }, pendingKeys.length > 0 ? 'running' : 'ok', state,
    pendingKeys.length > 0 ? '订单详情批次等待订单重试。' : '订单详情本轮已完成。', {
      action: pendingKeys.length > 0 ? 'batch_waiting_retry' : 'batch_completed',
      batchSize: 0,
    });
    return;
  }

  await recordOrderProgress('order_details', {
    total: progressTotal,
    uploaded,
    pending: pagePending(),
    failed: failedSnapshot().length,
    currentOrderId: null,
    currentOrderIndex: null,
    resumeOrderId: resumeOrderId(),
    failedOrderIds: failedSnapshot(),
    snapshotKeys: rows.map((entry) => entry.orderId),
    pendingOrderIds: pendingSnapshot(),
    lastError,
    listPhase: 'processing',
  }, 'running', state, `订单详情批次开始：本轮处理 ${batch.length} 单。`, {
    action: 'batch_started',
    batchSize: batch.length,
    resumeOrderId: resumeOrderId(),
  });

  let stopped = false;
  for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
    const pendingRow = batch[batchIndex]!;
    const orderId = pendingRow.orderId;
    const orderIndex = rows.findIndex((entry) => entry.orderId === orderId);
    await recordOrderProgress('order_details', {
      total: progressTotal,
      uploaded,
      pending: pagePending(),
      failed: failedSnapshot().length,
      currentOrderId: orderId,
      currentOrderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
      resumeOrderId: resumeOrderId(),
      failedOrderIds: failedSnapshot(),
      pendingOrderIds: pendingSnapshot(),
      lastError,
    }, 'running', state, `订单详情开始处理：${orderId}`, {
      action: 'order_started',
      orderId,
      orderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
      batchIndex: batchIndex + 1,
      batchSize: batch.length,
    });

    let attemptError: string | null = null;
    let attemptFailure: unknown = null;
    try {
      if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('order_details', state)) {
        stopped = true;
        break;
      }
      const detailUrl = tiktokOrderEndpointUrl(origin, 'order-get', { sellerId: boundTab.sellerId! });
      const detailBody = createOrderGetRequestBody([orderId]);
      const requestStartedAt = Date.now();
      let detail: BoundTikTokResponse;
      try {
        detail = await executeTikTokRequestWithTimeout(
          boundTab.tabId, detailUrl, detailBody, 'POST', ORDER_ITEM_REQUEST_TIMEOUT_MS,
        );
      } catch (error) {
        await recordOrderSyncRuntimeLog('order_details', 'tiktok_request', 'failed', '订单详情请求异常。', {
          stage: 'order_detail',
          method: 'POST',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('POST', detailUrl, detailBody),
          ...orderRequestExceptionDetails(error),
        });
        throw error;
      }
      const detailPayload = isRecord(detail.payload) ? detail.payload : null;
      const detailBusinessFailure = detailPayload === null
        ? null
        : tiktokBusinessFailure(detailPayload, '订单详情');
      const detailSchemaResult = detailPayload === null
        ? null
        : OrderGetResponseSchema.safeParse(detailPayload);
      if (!detail.ok) {
        await recordOrderSyncRuntimeLog('order_details', 'tiktok_request', 'failed', '订单详情响应失败。', {
          stage: 'order_detail',
          method: 'POST',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('POST', detailUrl, detailBody, detail),
          ...orderTikTokResponseDiagnostics(detail),
        });
        if (isTikTokAuthenticationFailure(detail)) {
          await clearOrderBinding(state, 'order_detail_authentication_failed');
          stopped = true;
        }
        attemptError = orderTikTokFailureSummary('订单详情请求失败', detail);
      } else if (isTikTokAuthenticationFailure(detail)) {
        await recordOrderSyncRuntimeLog('order_details', 'tiktok_request', 'failed', '订单详情响应要求重新登录。', {
          stage: 'order_detail',
          method: 'POST',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          failureReason: 'authentication_required',
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('POST', detailUrl, detailBody, detail),
          ...orderTikTokResponseDiagnostics(detail),
        });
        await clearOrderBinding(state, 'order_detail_authentication_failed');
        stopped = true;
        attemptError = '订单详情请求需要重新登录。';
      } else if (detailPayload === null) {
        await recordOrderSyncRuntimeLog('order_details', 'tiktok_request', 'failed', '订单详情响应为空。', {
          stage: 'order_detail',
          method: 'POST',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          failureReason: 'empty_payload',
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('POST', detailUrl, detailBody, detail),
          ...orderTikTokResponseDiagnostics(detail),
        });
        attemptError = `订单详情响应为空（${nullPayloadDiagnostic(detail)}）`;
      } else if (detailBusinessFailure !== null) {
        await recordOrderSyncRuntimeLog('order_details', 'tiktok_request', 'failed', '订单详情业务响应失败。', {
          stage: 'order_detail',
          method: 'POST',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          failureReason: 'business_code',
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('POST', detailUrl, detailBody, detail),
          ...orderTikTokResponseDiagnostics(detail),
        });
        attemptError = detailBusinessFailure;
      } else if (!detailSchemaResult?.success) {
        await recordOrderSyncRuntimeLog('order_details', 'tiktok_request', 'failed', '订单详情响应结构校验失败。', {
          stage: 'order_detail',
          method: 'POST',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          failureReason: 'schema_validation',
          schema: 'OrderGetResponseSchema',
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('POST', detailUrl, detailBody, detail),
          ...orderTikTokResponseDiagnostics(detail),
        });
        attemptError = `订单详情响应 schema 校验失败：${detailSchemaResult?.error.message ?? 'unknown error'}`;
      } else {
        await recordOrderSyncRuntimeLog('order_details', 'tiktok_request', 'succeeded', '订单详情响应已解析。', {
          stage: 'order_detail',
          method: 'POST',
          endpoint: orderTikTokEndpointPath(detailUrl),
          orderId,
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('POST', detailUrl, detailBody, detail),
          ...orderTikTokResponseDiagnostics(detail),
        });
        if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('order_details', state)) {
          stopped = true;
          break;
        }
        const uploadStartedAt = Date.now();
        try {
          await uploadOrderSyncDumpGuarded(settings, scope, createOrderSyncDump({
            domain: 'order_details',
            endpoint: detailUrl,
            method: 'POST',
            request: { body: detailBody },
            response: { status: detail.status, body: detailPayload },
            createdAt: new Date().toISOString(),
            mainOrderId: orderId,
          }));
          await recordOrderSyncRuntimeLog('order_details', 'erp_upload', 'succeeded', '订单详情已写入 ERP。', {
            stage: 'tts_erp_upload',
            orderId,
            endpoint: orderTikTokEndpointPath(detailUrl),
            durationMs: Math.max(0, Date.now() - uploadStartedAt),
          });
        } catch (error) {
          await recordOrderSyncRuntimeLog('order_details', 'erp_upload', 'failed', '订单详情写入 ERP 失败。', {
            stage: 'tts_erp_upload',
            orderId,
            endpoint: orderTikTokEndpointPath(detailUrl),
            durationMs: Math.max(0, Date.now() - uploadStartedAt),
            ...orderRequestExceptionDetails(error),
          });
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof StopOrderDomainBatch) {
        stopped = true;
        break;
      }
      attemptFailure = error;
      attemptError = error instanceof Error ? error.message : String(error);
    }

    if (attemptError !== null) {
      failedIds.add(orderId);
      lastError = attemptError;
      const pendingIndex = pendingKeys.indexOf(orderId);
      if (pendingIndex >= 0) {
        pendingKeys.splice(pendingIndex, 1);
        pendingKeys.push(orderId);
      } else {
        pendingKeys.push(orderId);
      }
      await recordOrderProgress('order_details', {
        total: progressTotal,
        uploaded,
        pending: pagePending(),
        failed: failedSnapshot().length,
        currentOrderId: null,
        currentOrderIndex: null,
        resumeOrderId: resumeOrderId(),
        failedOrderIds: failedSnapshot(),
        pendingOrderIds: pendingSnapshot(),
        lastFailedOrderId: orderId,
        lastError,
      }, 'running', state, `订单详情失败：${orderId}（${attemptError}）`, {
        action: 'order_failed',
        orderId,
        orderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
        error: sanitizeDiagnosticText(attemptError).slice(0, 240),
        ...orderRequestExceptionDetails(attemptFailure),
      });
    } else {
      const pendingIndex = pendingKeys.indexOf(orderId);
      if (pendingIndex >= 0) pendingKeys.splice(pendingIndex, 1);
      uploaded = uploadedBefore + terminalCount + Math.max(0, activeRows.length - pendingKeys.length);
      preservedFailedIds.delete(orderId);
      failedIds.delete(orderId);
      lastError = failedIds.size > 0 ? lastError : null;
      await recordOrderProgress('order_details', {
        total: progressTotal,
        uploaded,
        pending: pagePending(),
        failed: failedSnapshot().length,
        currentOrderId: null,
        currentOrderIndex: null,
        resumeOrderId: resumeOrderId(),
        failedOrderIds: failedSnapshot(),
        pendingOrderIds: pendingSnapshot(),
        lastSuccessAt: new Date().toISOString(),
        lastError,
      }, 'running', state, `订单详情同步成功：${orderId}`, {
        action: 'order_succeeded',
        orderId,
        orderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
      });
    }

    if (!stopped && batchIndex < batch.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, ORDER_DETAIL_FETCH_DELAY_MS));
    }
    if (stopped) break;
  }

  const completed = !stopped && pendingKeys.length === 0 && failedIds.size === 0 && pendingAfterPage === 0;
  await recordOrderProgress('order_details', {
    total: progressTotal,
    uploaded,
    pending: pagePending(),
    failed: failedSnapshot().length,
    currentOrderId: null,
    currentOrderIndex: null,
    resumeOrderId: resumeOrderId(),
    failedOrderIds: failedSnapshot(),
    pendingOrderIds: pendingSnapshot(),
    lastError: pagePending() > 0 ? lastError : null,
    ...resetOrderListProgress(),
  }, completed ? 'ok' : 'running', state,
  completed
    ? '订单详情批次完成：本轮全部订单已同步。'
    : `订单详情批次完成：成功 ${uploaded} 单，待处理 ${pagePending()} 单。`, {
    action: completed ? 'batch_completed' : 'batch_checkpointed',
    batchSize: batch.length,
    uploaded,
    failed: failedSnapshot().length,
    resumeOrderId: resumeOrderId(),
  });
  if (options.scheduleContinuation === false) return;
  if (completed) {
    if (typeof chrome.alarms.clear === 'function') await chrome.alarms.clear(ORDER_DETAILS_CONTINUATION_ALARM);
  } else if (!stopped) {
    await chrome.alarms.create(ORDER_DETAILS_CONTINUATION_ALARM, {
      delayInMinutes: LOGISTICS_CONTINUATION_DELAY_MINUTES,
    });
  }
}


async function syncOrderHistoryPages(
  state: OrderSyncState,
  settings: OrderApiSettings,
  scope: OrderSyncScope,
  boundTab: NonNullable<OrderSyncState['boundTab']>,
  origin: string,
  orderId: string,
): Promise<void> {
  const historyUrl = tiktokOrderHistoryEndpointUrl(origin, boundTab.sellerId!);
  let offset = 0;

  for (let pageIndex = 0; pageIndex < MAX_ORDER_HISTORY_PAGES; pageIndex += 1) {
    if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('order_history', state)) {
      throw new StopOrderDomainBatch('订单历史分页请求前同步作用域已变化。');
    }
    const historyBody = createOrderHistoryRequestBody(orderId, offset, ORDER_HISTORY_PAGE_SIZE);
    const requestStartedAt = Date.now();
    let detail: BoundTikTokResponse;
    try {
      detail = await executeTikTokRequestWithTimeout(
        boundTab.tabId, historyUrl, historyBody, 'POST', ORDER_ITEM_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      await recordOrderSyncRuntimeLog('order_history', 'tiktok_request', 'failed', '订单历史请求异常。', {
        stage: 'order_history',
        method: 'POST',
        endpoint: orderTikTokEndpointPath(historyUrl),
        orderId,
        page: pageIndex + 1,
        offset,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('POST', historyUrl, historyBody),
        ...orderRequestExceptionDetails(error),
      });
      throw error;
    }
    const detailPayload = isRecord(detail.payload) ? detail.payload : null;
    if (!detail.ok) {
      await recordOrderSyncRuntimeLog('order_history', 'tiktok_request', 'failed', '订单历史响应失败。', {
        stage: 'order_history',
        method: 'POST',
        endpoint: orderTikTokEndpointPath(historyUrl),
        orderId,
        page: pageIndex + 1,
        offset,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('POST', historyUrl, historyBody, detail),
        ...orderTikTokResponseDiagnostics(detail),
      });
      if (isTikTokAuthenticationFailure(detail)) {
        await clearOrderBinding(state, 'order_history_authentication_failed');
        throw new StopOrderDomainBatch('订单历史请求需要重新登录。');
      }
      throw new Error(orderTikTokFailureSummary('订单历史请求失败', detail));
    }
    if (isTikTokAuthenticationFailure(detail)) {
      await recordOrderSyncRuntimeLog('order_history', 'tiktok_request', 'failed', '订单历史响应要求重新登录。', {
        stage: 'order_history',
        method: 'POST',
        endpoint: orderTikTokEndpointPath(historyUrl),
        orderId,
        page: pageIndex + 1,
        offset,
        failureReason: 'authentication_required',
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('POST', historyUrl, historyBody, detail),
        ...orderTikTokResponseDiagnostics(detail),
      });
      await clearOrderBinding(state, 'order_history_authentication_failed');
      throw new StopOrderDomainBatch('订单历史请求需要重新登录。');
    }
    if (detailPayload === null) {
      await recordOrderSyncRuntimeLog('order_history', 'tiktok_request', 'failed', '订单历史响应为空。', {
        stage: 'order_history',
        method: 'POST',
        endpoint: orderTikTokEndpointPath(historyUrl),
        orderId,
        page: pageIndex + 1,
        offset,
        failureReason: 'empty_payload',
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('POST', historyUrl, historyBody, detail),
        ...orderTikTokResponseDiagnostics(detail),
      });
      throw new Error(`订单历史响应为空（${nullPayloadDiagnostic(detail)}）`);
    }
    const businessFailure = tiktokBusinessFailure(detailPayload, '订单历史');
    if (businessFailure !== null) {
      await recordOrderSyncRuntimeLog('order_history', 'tiktok_request', 'failed', '订单历史业务响应失败。', {
        stage: 'order_history',
        method: 'POST',
        endpoint: orderTikTokEndpointPath(historyUrl),
        orderId,
        page: pageIndex + 1,
        offset,
        failureReason: 'business_code',
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('POST', historyUrl, historyBody, detail),
        ...orderTikTokResponseDiagnostics(detail),
      });
      throw new Error(businessFailure);
    }
    const parsed = OrderHistoryResponseSchema.safeParse(detailPayload);
    if (!parsed.success) {
      await recordOrderSyncRuntimeLog('order_history', 'tiktok_request', 'failed', '订单历史响应结构校验失败。', {
        stage: 'order_history',
        method: 'POST',
        endpoint: orderTikTokEndpointPath(historyUrl),
        orderId,
        page: pageIndex + 1,
        offset,
        failureReason: 'schema_validation',
        schema: 'OrderHistoryResponseSchema',
        schemaError: sanitizeDiagnosticText(parsed.error.message).slice(0, 240),
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('POST', historyUrl, historyBody, detail),
        ...orderTikTokResponseDiagnostics(detail),
      });
      throw new Error(`订单历史响应 schema 校验失败：${parsed.error.message}`);
    }
    const pageRows = parsed.data.data.order_history;
    const totalCount = parsed.data.data.total_count;
    await recordOrderSyncRuntimeLog('order_history', 'tiktok_request', 'succeeded', '订单历史响应已解析。', {
      stage: 'order_history',
      method: 'POST',
      endpoint: orderTikTokEndpointPath(historyUrl),
      orderId,
      page: pageIndex + 1,
      offset,
      rowCount: pageRows.length,
      totalCount,
      durationMs: Math.max(0, Date.now() - requestStartedAt),
      ...orderTikTokRuntimeExchange('POST', historyUrl, historyBody, detail),
      ...orderTikTokResponseDiagnostics(detail),
    });
    if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('order_history', state)) {
      throw new StopOrderDomainBatch('订单历史分页上传前同步作用域已变化。');
    }
    const uploadStartedAt = Date.now();
    try {
      await uploadOrderSyncDumpGuarded(settings, scope, createOrderSyncDump({
        domain: 'order_history',
        endpoint: historyUrl,
        method: 'POST',
        request: { body: historyBody },
        response: { status: detail.status, body: detailPayload },
        createdAt: new Date().toISOString(),
        mainOrderId: orderId,
      }));
      await recordOrderSyncRuntimeLog('order_history', 'erp_upload', 'succeeded', '订单历史分页已写入 ERP。', {
        stage: 'tts_erp_upload',
        orderId,
        page: pageIndex + 1,
        offset,
        rowCount: pageRows.length,
        totalCount,
        endpoint: orderTikTokEndpointPath(historyUrl),
        durationMs: Math.max(0, Date.now() - uploadStartedAt),
      });
    } catch (error) {
      await recordOrderSyncRuntimeLog('order_history', 'erp_upload', 'failed', '订单历史分页写入 ERP 失败。', {
        stage: 'tts_erp_upload',
        orderId,
        page: pageIndex + 1,
        offset,
        endpoint: orderTikTokEndpointPath(historyUrl),
        durationMs: Math.max(0, Date.now() - uploadStartedAt),
        ...orderRequestExceptionDetails(error),
      });
      throw error;
    }

    offset += pageRows.length;
    if (offset >= totalCount) return;
    if (pageRows.length === 0) {
      throw new Error(`订单历史分页未前进：offset=${offset}, total_count=${totalCount}`);
    }
  }

  throw new Error(`订单历史分页超过安全上限：${MAX_ORDER_HISTORY_PAGES} 页`);
}


/**
 * 订单历史（order/history）逐单请求并上传。结构与订单详情批次相同（N+1 模式）。
 */
async function processOrderHistoryBatch(
  state: OrderSyncState,
  settings: OrderApiSettings,
  scope: OrderSyncScope,
  boundTab: NonNullable<OrderSyncState['boundTab']>,
  origin: string,
  rows: Array<{ orderId: string; row: Record<string, unknown>; status: number }>,
  terminalSkipped = 0,
  options: LogisticsBatchOptions = {},
): Promise<void> {
  const previous = state.orderProgress?.domains.order_history ?? createDefaultOrderProgress().domains.order_history;
  // Cancellation is terminal only for logistics. History is precisely where
  // the cancellation timeline is captured, so cancelled orders must run.
  const activeRows = rows;
  const pendingKeys = pendingOrderDomainKeys(previous, activeRows.map((entry) => ({ key: entry.orderId })));
  const entryById = new Map(activeRows.map((entry) => [entry.orderId, entry]));
  const preservedFailedIds = new Set(options.preservedFailedOrderIds ?? []);
  const failedIds = new Set([
    ...(previous.failedOrderIds ?? []).filter((key) => pendingKeys.includes(key)),
    ...preservedFailedIds,
  ]);
  let lastError = previous.lastError;
  const terminalCount = Math.max(0, terminalSkipped);
  const roundTotal = activeRows.length + terminalCount;
  const progressTotal = Math.max(roundTotal, options.total ?? roundTotal);
  const uploadedBefore = Math.max(0, options.uploadedBefore ?? 0);
  const pendingAfterPage = Math.max(0, options.pendingAfterPage ?? 0);
  const pagePending = () => pendingAfterPage + new Set([...preservedFailedIds, ...pendingKeys]).size;
  let uploaded = uploadedBefore + terminalCount + Math.max(0, activeRows.length - pendingKeys.length);
  const batch = pendingKeys.slice(0, LOGISTICS_BATCH_SIZE)
    .map((orderId) => entryById.get(orderId))
    .filter((entry): entry is (typeof rows)[number] => entry !== undefined);
  const pendingSnapshot = () => [...new Set([...preservedFailedIds, ...pendingKeys])];
  const failedSnapshot = () => [...failedIds];
  const resumeOrderId = () => pendingKeys[0] ?? null;

  if (batch.length === 0) {
    await recordOrderProgress('order_history', {
      total: progressTotal,
      uploaded,
      pending: pagePending(),
      failed: failedSnapshot().length,
      currentOrderId: null,
      currentOrderIndex: null,
      resumeOrderId: resumeOrderId(),
      failedOrderIds: failedSnapshot(),
      snapshotKeys: rows.map((entry) => entry.orderId),
      pendingOrderIds: pendingSnapshot(),
      lastError: pagePending() > 0 ? lastError : null,
      ...resetOrderListProgress(),
    }, pendingKeys.length > 0 ? 'running' : 'ok', state,
    pendingKeys.length > 0 ? '订单历史批次等待订单重试。' : '订单历史本轮已完成。', {
      action: pendingKeys.length > 0 ? 'batch_waiting_retry' : 'batch_completed',
      batchSize: 0,
    });
    return;
  }

  await recordOrderProgress('order_history', {
    total: progressTotal,
    uploaded,
    pending: pagePending(),
    failed: failedSnapshot().length,
    currentOrderId: null,
    currentOrderIndex: null,
    resumeOrderId: resumeOrderId(),
    failedOrderIds: failedSnapshot(),
    snapshotKeys: rows.map((entry) => entry.orderId),
    pendingOrderIds: pendingSnapshot(),
    lastError,
    listPhase: 'processing',
  }, 'running', state, `订单历史批次开始：本轮处理 ${batch.length} 单。`, {
    action: 'batch_started',
    batchSize: batch.length,
    resumeOrderId: resumeOrderId(),
  });

  let stopped = false;
  for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
    const pendingRow = batch[batchIndex]!;
    const orderId = pendingRow.orderId;
    const orderIndex = rows.findIndex((entry) => entry.orderId === orderId);
    await recordOrderProgress('order_history', {
      total: progressTotal,
      uploaded,
      pending: pagePending(),
      failed: failedSnapshot().length,
      currentOrderId: orderId,
      currentOrderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
      resumeOrderId: resumeOrderId(),
      failedOrderIds: failedSnapshot(),
      pendingOrderIds: pendingSnapshot(),
      lastError,
    }, 'running', state, `订单历史开始处理：${orderId}`, {
      action: 'order_started',
      orderId,
      orderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
      batchIndex: batchIndex + 1,
      batchSize: batch.length,
    });

    let attemptError: string | null = null;
    let attemptFailure: unknown = null;
    try {
      if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('order_history', state)) {
        stopped = true;
        break;
      }
      await syncOrderHistoryPages(state, settings, scope, boundTab, origin, orderId);
    } catch (error) {
      if (error instanceof StopOrderDomainBatch) {
        stopped = true;
        break;
      }
      attemptFailure = error;
      attemptError = error instanceof Error ? error.message : String(error);
    }

    if (attemptError !== null) {
      failedIds.add(orderId);
      lastError = attemptError;
      const pendingIndex = pendingKeys.indexOf(orderId);
      if (pendingIndex >= 0) {
        pendingKeys.splice(pendingIndex, 1);
        pendingKeys.push(orderId);
      } else {
        pendingKeys.push(orderId);
      }
      await recordOrderProgress('order_history', {
        total: progressTotal,
        uploaded,
        pending: pagePending(),
        failed: failedSnapshot().length,
        currentOrderId: null,
        currentOrderIndex: null,
        resumeOrderId: resumeOrderId(),
        failedOrderIds: failedSnapshot(),
        pendingOrderIds: pendingSnapshot(),
        lastFailedOrderId: orderId,
        lastError,
      }, 'running', state, `订单历史失败：${orderId}（${attemptError}）`, {
        action: 'order_failed',
        orderId,
        orderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
        error: sanitizeDiagnosticText(attemptError).slice(0, 240),
        ...orderRequestExceptionDetails(attemptFailure),
      });
    } else {
      const pendingIndex = pendingKeys.indexOf(orderId);
      if (pendingIndex >= 0) pendingKeys.splice(pendingIndex, 1);
      uploaded = uploadedBefore + terminalCount + Math.max(0, activeRows.length - pendingKeys.length);
      preservedFailedIds.delete(orderId);
      failedIds.delete(orderId);
      lastError = failedIds.size > 0 ? lastError : null;
      await recordOrderProgress('order_history', {
        total: progressTotal,
        uploaded,
        pending: pagePending(),
        failed: failedSnapshot().length,
        currentOrderId: null,
        currentOrderIndex: null,
        resumeOrderId: resumeOrderId(),
        failedOrderIds: failedSnapshot(),
        pendingOrderIds: pendingSnapshot(),
        lastSuccessAt: new Date().toISOString(),
        lastError,
      }, 'running', state, `订单历史同步成功：${orderId}`, {
        action: 'order_succeeded',
        orderId,
        orderIndex: orderIndex >= 0 ? orderIndex + 1 : null,
      });
    }

    if (!stopped && batchIndex < batch.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, ORDER_DETAIL_FETCH_DELAY_MS));
    }
    if (stopped) break;
  }

  const completed = !stopped && pendingKeys.length === 0 && failedIds.size === 0 && pendingAfterPage === 0;
  await recordOrderProgress('order_history', {
    total: progressTotal,
    uploaded,
    pending: pagePending(),
    failed: failedSnapshot().length,
    currentOrderId: null,
    currentOrderIndex: null,
    resumeOrderId: resumeOrderId(),
    failedOrderIds: failedSnapshot(),
    pendingOrderIds: pendingSnapshot(),
    lastError: pagePending() > 0 ? lastError : null,
    ...resetOrderListProgress(),
  }, completed ? 'ok' : 'running', state,
  completed
    ? '订单历史批次完成：本轮全部订单已同步。'
    : `订单历史批次完成：成功 ${uploaded} 单，待处理 ${pagePending()} 单。`, {
    action: completed ? 'batch_completed' : 'batch_checkpointed',
    batchSize: batch.length,
    uploaded,
    failed: failedSnapshot().length,
    resumeOrderId: resumeOrderId(),
  });
  if (options.scheduleContinuation === false) return;
  if (completed) {
    if (typeof chrome.alarms.clear === 'function') await chrome.alarms.clear(ORDER_HISTORY_CONTINUATION_ALARM);
  } else if (!stopped) {
    await chrome.alarms.create(ORDER_HISTORY_CONTINUATION_ALARM, {
      delayInMinutes: LOGISTICS_CONTINUATION_DELAY_MINUTES,
    });
  }
}


type StatementPollingRow = {
  statementId: string;
  statementVersion: number;
  row: Record<string, unknown>;
  endpoint: string;
  statementSkuDetailId?: string;
  // §2.5 dumps 契约：list 抓取时的上游 HTTP 状态必须随 row 一同上传，避免硬编码 200。
  status: number;
};


/** Settlement is a global statement list; it is not keyed by main_order_id. */
async function fetchStatementRows(state: OrderSyncState): Promise<StatementPollingRow[]> {
  const boundTab = state.boundTab!;
  const origin = TIKTOK_STATEMENT_API_ORIGIN;
  const identity = { sellerId: boundTab.sellerId!, region: orderShopRegion(state)! };
  const rows: StatementPollingRow[] = [];
  let from = 0;
  let hasMore = true;
  let listPageCount: number | null = null;
  await recordOrderProgress('statements', {
    listPhase: 'list_fetching',
    listPage: 1,
    listPageCount: null,
    listRowsFetched: 0,
    listTotalRows: null,
  }, 'running', state, '结算列表读取开始。', {
    action: 'list_fetch_started',
    page: 1,
  });
  for (let page = 0; page < MAX_STATEMENT_LIST_PAGES; page += 1) {
    if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('statements', state)) {
      throw new StopOrderDomainBatch('订单同步作用域已变化，停止继续读取结算列表。');
    }
    if (page > 0) {
      await recordOrderProgress('statements', {
        listPhase: 'list_fetching',
        listPage: page + 1,
        listPageCount,
      }, 'running', state, `正在读取结算列表：第 ${page + 1} 页${listPageCount ? ` / 约 ${listPageCount} 页` : ''}。`, {
        action: 'list_page_started',
        page: page + 1,
        pageCount: listPageCount,
      });
    }
    const query = createStatementListQuery({ from, size: STATEMENT_LIST_PAGE_SIZE });
    const url = tiktokStatementEndpointUrl(origin, 'statement-list', identity, query);
    const requestStartedAt = Date.now();
    let result: BoundTikTokResponse;
    try {
      result = await executeTikTokRequestWithTimeout(boundTab.tabId, url, {}, 'GET');
    } catch (error) {
      await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算列表请求异常。', {
        stage: 'statement_list',
        method: 'GET',
        endpoint: orderTikTokEndpointPath(url),
        page: page + 1,
        from,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('GET', url, undefined),
        ...orderRequestExceptionDetails(error),
      });
      throw error;
    }
    if (!result.ok) {
      await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算列表响应失败。', {
        stage: 'statement_list',
        method: 'GET',
        endpoint: orderTikTokEndpointPath(url),
        page: page + 1,
        from,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('GET', url, undefined, result),
        ...orderTikTokResponseDiagnostics(result),
      });
      if (isTikTokAuthenticationFailure(result)) await clearOrderBinding(state, 'statement_authentication_failed');
      throw new Error(orderTikTokFailureSummary('结算列表请求失败', result));
    }
    if (isTikTokAuthenticationFailure(result)) {
      await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算列表响应要求重新登录。', {
        stage: 'statement_list',
        method: 'GET',
        endpoint: orderTikTokEndpointPath(url),
        page: page + 1,
        from,
        failureReason: 'authentication_required',
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('GET', url, undefined, result),
        ...orderTikTokResponseDiagnostics(result),
      });
      await clearOrderBinding(state, 'statement_authentication_failed');
      throw new Error('结算列表请求需要重新登录。');
    }
    const parsed = StatementListResponseSchema.safeParse(result.payload);
    if (!parsed.success) {
      await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算列表响应格式无效。', {
        stage: 'statement_list',
        method: 'GET',
        endpoint: orderTikTokEndpointPath(url),
        page: page + 1,
        from,
        failureReason: 'schema_invalid',
        schemaError: sanitizeDiagnosticText(parsed.error.message).slice(0, 240),
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('GET', url, undefined, result),
        ...orderTikTokResponseDiagnostics(result),
      });
      throw new Error('结算列表响应格式无效');
    }
    if (parsed.data.code !== 0) {
      await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算列表业务响应失败。', {
        stage: 'statement_list',
        method: 'GET',
        endpoint: orderTikTokEndpointPath(url),
        page: page + 1,
        from,
        failureReason: 'business_code',
        businessCode: parsed.data.code,
        businessMessage: sanitizeDiagnosticText(parsed.data.message).slice(0, 160),
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...orderTikTokRuntimeExchange('GET', url, undefined, result),
        ...orderTikTokResponseDiagnostics(result),
      });
      throw new Error(`结算列表业务响应失败：code=${parsed.data.code}`);
    }
    const data = parsed.data.data;
    await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'succeeded', '结算列表响应已解析。', {
      stage: 'statement_list',
      method: 'GET',
      endpoint: orderTikTokEndpointPath(url),
      page: page + 1,
      from,
      rowCount: data.statement_records.length,
      totalRecord: Number.isFinite(Number(data.total_record))
        ? Math.max(0, Number(data.total_record))
        : null,
      hasMore: data.search_next_has_more === true,
      durationMs: Math.max(0, Date.now() - requestStartedAt),
      ...orderTikTokRuntimeExchange('GET', url, undefined, result),
      ...orderTikTokResponseDiagnostics(result),
    });
    rows.push(...data.statement_records.map((row) => ({
      statementId: row.statement_id,
      statementVersion: row.statement_version,
      row,
      endpoint: url,
      ...(typeof (row as Record<string, unknown>).statement_sku_detail_id === 'string'
        ? { statementSkuDetailId: (row as Record<string, unknown>).statement_sku_detail_id as string }
        : {}),
      // §2.5 dumps 契约：上传时禁止硬编码 200；用真实上游 status。
      status: result.status,
    })));
    const parsedTotal = Number(data.total_record);
    const total = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null;
    const pageCount = total !== null && total > 0
      ? Math.max(1, Math.ceil(total / STATEMENT_LIST_PAGE_SIZE))
      : null;
    listPageCount = pageCount;
    await recordOrderProgress('statements', {
      listPhase: 'list_fetching',
      listPage: page + 1,
      listPageCount: pageCount,
      listRowsFetched: rows.length,
      listTotalRows: total,
    }, 'running', state, `正在读取结算列表：第 ${page + 1} 页${pageCount ? ` / 约 ${pageCount} 页` : ''}。`, {
      action: 'list_page_fetched',
      page: page + 1,
      pageCount,
      fetchedRows: rows.length,
      totalRows: total,
    });
    hasMore = data.search_next_has_more === true;
    if (!hasMore || data.statement_records.length === 0 || (total !== null && rows.length >= total)) break;
    from += data.statement_records.length;
  }
  if (hasMore) throw new Error('结算列表分页超过安全上限。');
  return rows;
}


async function fetchStatementSkuDetailRefs(
  state: OrderSyncState,
  statement: Pick<StatementPollingRow, 'statementId' | 'statementVersion'>,
): Promise<StatementSkuDetailRef[]> {
  const boundTab = state.boundTab!;
  const origin = TIKTOK_STATEMENT_API_ORIGIN;
  const identity = { sellerId: boundTab.sellerId!, region: orderShopRegion(state)! };
  const refs = new Map<string, StatementSkuDetailRef>();
  const variants = [
    { settlementStatus: 1 as const, pageType: 10 as const },
    { settlementStatus: 2 as const, pageType: 6 as const },
  ];

  for (const variant of variants) {
    let from = 0;
    let hasMore = true;
    for (let page = 0; page < MAX_STATEMENT_LIST_PAGES; page += 1) {
      if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('statements', state)) {
        throw new StopOrderDomainBatch('结算订单明细列表请求前同步作用域已变化。');
      }
      const query = createStatementOrderListQuery({
        statementId: statement.statementId,
        statementVersion: statement.statementVersion,
        from,
        size: STATEMENT_LIST_PAGE_SIZE,
        ...variant,
      });
      const url = tiktokStatementEndpointUrl(origin, 'statement-order-list', identity, query);
      const requestStartedAt = Date.now();
      let response: BoundTikTokResponse;
      try {
        response = await executeTikTokRequestWithTimeout(
          boundTab.tabId, url, {}, 'POST', ORDER_ITEM_REQUEST_TIMEOUT_MS,
        );
      } catch (error) {
        await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算订单明细列表请求异常。', {
          stage: 'statement_order_list',
          method: 'POST',
          endpoint: orderTikTokEndpointPath(url),
          statementId: statement.statementId,
          statementVersion: statement.statementVersion,
          settlementStatus: variant.settlementStatus,
          page: page + 1,
          from,
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('POST', url, undefined),
          ...orderRequestExceptionDetails(error),
        });
        throw error;
      }
      if (!response.ok) {
        await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算订单明细列表响应失败。', {
          stage: 'statement_order_list',
          method: 'POST',
          endpoint: orderTikTokEndpointPath(url),
          statementId: statement.statementId,
          statementVersion: statement.statementVersion,
          settlementStatus: variant.settlementStatus,
          page: page + 1,
          from,
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          ...orderTikTokRuntimeExchange('POST', url, undefined, response),
          ...orderTikTokResponseDiagnostics(response),
        });
        if (isTikTokAuthenticationFailure(response)) {
          await clearOrderBinding(state, 'statement_order_list_authentication_failed');
          throw new StopOrderDomainBatch('结算订单明细列表请求需要重新登录。');
        }
        throw new Error(orderTikTokFailureSummary('结算订单明细列表请求失败', response));
      }
      if (isTikTokAuthenticationFailure(response)) {
        await clearOrderBinding(state, 'statement_order_list_authentication_failed');
        throw new StopOrderDomainBatch('结算订单明细列表请求需要重新登录。');
      }
      const payload = isRecord(response.payload) ? response.payload : null;
      if (payload === null) {
        throw new Error(`结算订单明细列表响应为空（${nullPayloadDiagnostic(response)}）`);
      }
      const businessFailure = tiktokBusinessFailure(payload, '结算订单明细列表');
      if (businessFailure !== null) throw new Error(businessFailure);
      const parsed = StatementOrderListResponseSchema.safeParse(payload);
      if (!parsed.success) {
        await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算订单明细列表响应结构校验失败。', {
          stage: 'statement_order_list',
          method: 'POST',
          endpoint: orderTikTokEndpointPath(url),
          statementId: statement.statementId,
          statementVersion: statement.statementVersion,
          settlementStatus: variant.settlementStatus,
          page: page + 1,
          from,
          failureReason: 'schema_validation',
          schema: 'StatementOrderListResponseSchema',
          schemaError: sanitizeDiagnosticText(parsed.error.message).slice(0, 240),
          ...orderTikTokRuntimeExchange('POST', url, undefined, response),
          ...orderTikTokResponseDiagnostics(response),
        });
        throw new Error(`结算订单明细列表响应 schema 校验失败：${parsed.error.message}`);
      }
      for (const ref of extractStatementSkuDetailRefs(parsed.data, statement)) {
        refs.set(ref.statementSkuDetailId, ref);
      }
      const pageRows = parsed.data.data.order_records;
      const parsedTotal = Number(parsed.data.data.total_record);
      const total = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null;
      await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'succeeded', '结算订单明细列表响应已解析。', {
        stage: 'statement_order_list',
        method: 'POST',
        endpoint: orderTikTokEndpointPath(url),
        statementId: statement.statementId,
        statementVersion: statement.statementVersion,
        settlementStatus: variant.settlementStatus,
        page: page + 1,
        from,
        rowCount: pageRows.length,
        totalRecord: total,
        discoveredSkuDetails: refs.size,
        ...orderTikTokRuntimeExchange('POST', url, undefined, response),
        ...orderTikTokResponseDiagnostics(response),
      });
      hasMore = parsed.data.data.search_next_has_more === true
        || (total !== null && from + pageRows.length < total);
      if (!hasMore || pageRows.length === 0) break;
      from += pageRows.length;
    }
    if (hasMore) throw new Error('结算订单明细列表分页超过安全上限。');
  }

  await recordOrderSyncRuntimeLog('statements', 'statement_detail_refs_discovered', 'succeeded', '结算 SKU 明细引用发现完成。', {
    stage: 'statement_order_list',
    statementId: statement.statementId,
    statementVersion: statement.statementVersion,
    detailCount: refs.size,
  });
  return [...refs.values()];
}


/** 订单域：列表 1 次请求拿到全部字段，逐单上传（无需详情请求）。 */
let logFlushInFlight = false;

const orderRunCoordinator = new OrderRunCoordinator();

export type OrderSyncLockSnapshot = OrderRunLockSnapshot;

export function getOrderSyncLockSnapshot(): OrderSyncLockSnapshot {
  return orderRunCoordinator.snapshot();
}

let initialOrderDomainSyncStartedFor: string | null = null;
let initialOrderDomainSyncPromise: Promise<void> | null = null;


/**
 * 记录订单域进度，供 popup「订单」页签渲染进度条。
 *
 * 每单上传成功后都落一次盘，进度条才会在轮询过程中真的动起来（而不是只在本轮
 * 结束时跳一下）。
 *
 * 2026-09-12 观测改进（lane fix/order-list-fetch-empty-parsing）：增可选 `note`：
 * 传值时同步写一条 `runtimeLogs` info（component=order_sync），服务端 plugin_logs 可查。
 * 用于「订单/物流/结算 alarm 触发但拉到 0 行」这类 silent return：
 * 原本只写 `state.orderProgress`（popup 进度），plugin_logs 零行 → 三步分析才能定位；
 * 现在服务端直接能看到「订单域轮询返回 0 行」。
 */
async function recordOrderProgress(
  domain: OrderDomainKey,
  row: Partial<OrderDomainProgressRow>,
  status: OrderDomainProgress['status'],
  expectedState?: OrderSyncState,
  note?: string,
  noteDetails: Record<string, unknown> = {},
): Promise<void> {
  await orderSyncStateStore.update((cur) => {
    if (expectedState && (cur.boundTab?.tabId !== expectedState.boundTab?.tabId
      || cur.boundTab?.sellerId !== expectedState.boundTab?.sellerId
      || normaliseOrderSyncBaseUrl(cur.settings.syncBaseUrl) !== normaliseOrderSyncBaseUrl(expectedState.settings.syncBaseUrl)
      || cur.settings.syncToken.trim() !== expectedState.settings.syncToken.trim())) return cur;
    const base = cur.orderProgress ?? createDefaultOrderProgress();
    const expectedRunId = expectedState?.orderProgress?.domains[domain]?.syncRunId;
    if (expectedRunId && base.domains[domain]?.syncRunId !== expectedRunId) return cur;
    const progressAt = new Date().toISOString();
    const previousRow = base.domains[domain];
    const nextRow: OrderDomainProgressRow = {
      ...previousRow,
      ...row,
      lastProgressAt: progressAt,
      syncRunStatus: status === 'running' ? 'running' : status === 'ok' ? 'done' : 'partial_failed',
      ...(status === 'ok' ? { lastSuccessAt: progressAt } : {}),
    };
    const domains = { ...base.domains, [domain]: nextRow };
    const domainStatuses = Object.values(domains).map((progressRow) => progressRow.syncRunStatus);
    const overallStatus: OrderDomainProgress['status'] = domainStatuses.includes('running')
      ? 'running'
      : domainStatuses.includes('partial_failed') || domainStatuses.includes('interrupted')
        ? 'partial'
        : domainStatuses.includes('done')
          ? 'ok'
          : status;
    const next: OrderDomainProgress = {
      status: overallStatus,
      lastRunAt: progressAt,
      domains,
    };
    const tail: OrderRuntimeLog[] = note === undefined ? [] : [{
      id: `order-sync-${domain}-${Date.now()}`,
      occurredAt: new Date().toISOString(),
      level: 'info',
      message: note,
      context: runtimeLogContext('order_sync', 'progress', status === 'ok' ? 'succeeded' : 'recorded', {
        domain,
        total: row.total ?? null,
        covered: row.covered ?? null,
          uploaded: row.uploaded ?? null,
          pending: row.pending ?? null,
          failed: row.failed ?? null,
          currentOrderId: row.currentOrderId ?? null,
          currentOrderIndex: row.currentOrderIndex ?? null,
          ...noteDetails,
        }),
    } satisfies OrderRuntimeLog];
    return {
      ...cur,
      orderProgress: next,
      ...(tail.length === 0 ? {} : { runtimeLogs: [...cur.runtimeLogs, ...tail].slice(-MAX_RUNTIME_LOGS) }),
    };
  });
}


/** Persist active order-domain lifecycle events so an export can distinguish
 * "alarm never fired" from "TikTok returned empty" and "upload failed". */
export async function recordOrderSyncRuntimeLog(
  domain: OrderPollingDomain | 'all',
  event: string,
  outcome: 'started' | 'succeeded' | 'failed' | 'skipped' | 'recorded',
  message: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await orderSyncStateStore.update((current) => ({
    ...current,
    runtimeLogs: [...current.runtimeLogs, {
      id: `order-sync-${domain}-${event}-${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
      level: outcome === 'failed' ? 'error' : 'info',
      message,
      context: runtimeLogContext('order_sync', event, outcome, { domain, ...details }),
    } satisfies OrderRuntimeLog].slice(-MAX_RUNTIME_LOGS),
  }));
}


function preserveOrderDomainProgressAfterEmptyList(
  previous: OrderDomainProgressRow,
  message: string,
): Partial<OrderDomainProgressRow> {
  return {
    total: previous.total,
    covered: previous.covered,
    uploaded: previous.uploaded,
    pending: previous.pending,
    failed: previous.failed ?? 0,
    currentOrderId: previous.currentOrderId ?? null,
    currentOrderIndex: previous.currentOrderIndex ?? null,
    resumeOrderId: previous.resumeOrderId ?? null,
    failedOrderIds: previous.failedOrderIds ?? [],
    snapshotKeys: previous.snapshotKeys ?? [],
    pendingOrderIds: previous.pendingOrderIds ?? [],
    orderListCheckpoint: previous.orderListCheckpoint ?? null,
    lastFailedOrderId: previous.lastFailedOrderId ?? null,
    lastSuccessAt: previous.lastSuccessAt ?? null,
    lastError: message,
    ...resetOrderListProgress(),
  };
}


function orderPollingGateDetails(state: OrderSyncState): Record<string, unknown> {
  return {
    hasOrderBoundTab: Boolean(state.boundTab?.tabId),
    hasSellerId: Boolean(state.boundTab?.sellerId),
    hasShopRegion: Boolean(orderShopRegion(state)),
    shopRegion: orderShopRegion(state),
    hasSyncToken: state.settings.syncToken.trim().length > 0,
    syncPaused: state.settings.syncPaused === true,
    orderDomainSyncEnabled: isOrderDomainSyncEnabled(state.settings),
  };
}

function orderPollingGateMessage(state: OrderSyncState, domain: string): string {
  return orderShopRegion(state)
    ? `${domain} 主动轮询跳过：前置条件未满足。`
    : `${domain} 主动轮询已拦截：店铺地区未配置，暂不请求 TikTok。`;
}


export async function handleOrderSyncAlarm(trigger: OrderSyncTrigger = 'automatic'): Promise<boolean> {
  const result = await orderRunCoordinator.run({
    domain: 'orders',
    trigger,
    onDeferred: async (reason) => {
      await deferOrderDomainAlarm('orders');
      await recordOrderSyncRuntimeLog('orders', 'alarm_deferred', 'skipped', '订单自动轮询因其他订单域任务占用而延后。', { reason });
    },
    work: async () => {
      try {
        await beginOrderDomainRun('orders', trigger);
        await recordOrderSyncRuntimeLog('orders', 'alarm_started', 'started', '订单主动轮询开始。', { trigger });
        const pagePipelineUsed = await handleOrderSyncAlarmOnce(trigger);
        const current = await orderSyncStateStore.read();
        const row = current.orderProgress?.domains.orders;
        if (current.boundTab?.sellerId && current.settings.syncToken.trim()
          && isOrderDomainSyncEnabled(current.settings) && shouldScheduleNextOrderDomainRound(row)) {
          await scheduleNextOrderDomainRound('orders');
        }
        await recordOrderSyncRuntimeLog(
          'orders',
          'alarm_completed',
          row?.lastError ? 'failed' : 'succeeded',
          row?.lastError ? '订单主动轮询结束，但存在失败。' : '订单主动轮询结束。',
          {
            trigger,
            status: current.orderProgress?.status ?? 'idle',
            total: row?.total ?? 0,
            uploaded: row?.uploaded ?? 0,
            pending: row?.pending ?? 0,
            lastError: row?.lastError ?? null,
          },
        );
        return pagePipelineUsed;
      } catch (error) {
        await recordOrderSyncRuntimeLog('orders', 'alarm_failed', 'failed', '订单主动轮询异常退出。', {
          trigger,
          error: error instanceof Error ? sanitizeDiagnosticText(error.message).slice(0, 240) : String(error),
        });
        throw error;
      }
    },
  });
  if (result.status === 'skipped') {
    await recordOrderSyncRuntimeLog('orders', 'alarm_skipped', 'skipped', '订单主动轮询跳过：上一轮仍在执行。', {
      reason: result.reason,
    });
    return false;
  }
  return result.status === 'completed' ? result.value : false;
}


/**
 * Order page pipeline: selected rows are handed to order upload immediately.
 * Logistics is a separate consumer driven by its own alarm/reconcile queue;
 * an N+1 logistics request must never hold the next order page hostage.
 */
function createOrderPagePipeline(
  state: OrderSyncState,
  settings: OrderApiSettings,
  scope: OrderSyncScope,
  boundTab: NonNullable<OrderSyncState['boundTab']>,
  origin: string,
  trigger: OrderSyncTrigger,
): OrderPagePipeline {
  let uploaded = 0;
  const failedOrderIds = new Set<string>();
  let logisticsUploaded = 0;
  const logisticsFailedOrderIds = new Set<string>();
  const logisticsQueue: Array<{
    rows: OrderListRow[];
    total: number;
    pendingAfterPage: number;
    scheduleContinuation: boolean;
  }> = [];
  let logisticsQueueRunning = false;
  let logisticsDrainPromise: Promise<void> | null = null;
  const orderUrl = tiktokOrderEndpointUrl(origin, 'order-list', { sellerId: boundTab.sellerId! });

  const drainLogisticsQueue = async (): Promise<void> => {
    if (logisticsQueueRunning) return;
    logisticsQueueRunning = true;
    const releaseRun = orderRunCoordinator.reserve('logistics');
    try {
      const startedState = await beginOrderDomainRun('logistics', trigger);
      const runState = withCurrentOrderDomainRun(state, startedState, 'logistics');
      while (logisticsQueue.length > 0) {
        const item = logisticsQueue.shift()!;
        try {
          await processLogisticsBatch(
            runState,
            settings,
            scope,
            boundTab,
            origin,
            item.rows,
            0,
            {
              total: item.total,
              uploadedBefore: logisticsUploaded,
              pendingAfterPage: item.pendingAfterPage,
              preservedFailedOrderIds: [...logisticsFailedOrderIds],
              scheduleContinuation: item.scheduleContinuation,
            },
          );
          const afterLogistics = await orderSyncStateStore.read();
          (afterLogistics.orderProgress?.domains.logistics.failedOrderIds ?? [])
            .forEach((orderId) => logisticsFailedOrderIds.add(orderId));
          logisticsUploaded = Math.max(
            logisticsUploaded,
            afterLogistics.orderProgress?.domains.logistics.uploaded ?? logisticsUploaded,
          );
        } catch (error) {
          await recordOrderSyncRuntimeLog('logistics', 'queue_failed', 'failed', '物流页队列处理异常退出。', {
            stage: 'logistics_page_queue',
            error: error instanceof Error ? sanitizeDiagnosticText(error.message).slice(0, 240) : String(error),
          });
          if (await isOrderSyncScopeCurrent(runState)) await deferOrderDomainAlarm('logistics');
          break;
        }
      }
    } finally {
      logisticsQueueRunning = false;
      releaseRun();
    }
  };

  const enqueueLogisticsPage = (page: OrderListPage, total: number, pendingAfterPage: number): void => {
    if (page.rows.length === 0) return;
    logisticsQueue.push({
      rows: page.rows,
      total,
      pendingAfterPage,
      scheduleContinuation: !page.hasMore,
    });
    if (logisticsDrainPromise) return;
    logisticsDrainPromise = drainLogisticsQueue().catch(async (error) => {
      await recordOrderSyncRuntimeLog('logistics', 'queue_failed', 'failed', '物流页队列启动异常退出。', {
        stage: 'logistics_page_queue',
        error: error instanceof Error ? sanitizeDiagnosticText(error.message).slice(0, 240) : String(error),
      });
    }).finally(() => { logisticsDrainPromise = null; });
  };

  // ── order_details 队列（与物流同模式，N+1 逐单详情）──
  const detailsFailedOrderIds = new Set<string>();
  const detailsQueue: Array<{
    rows: OrderListRow[];
    total: number;
    pendingAfterPage: number;
    scheduleContinuation: boolean;
  }> = [];
  let detailsQueueRunning = false;
  let detailsDrainPromise: Promise<void> | null = null;
  let detailsUploaded = 0;

  const drainDetailsQueue = async (): Promise<void> => {
    if (detailsQueueRunning) return;
    detailsQueueRunning = true;
    const releaseRun = orderRunCoordinator.reserve('order_details');
    try {
      const startedState = await beginOrderDomainRun('order_details', trigger);
      const runState = withCurrentOrderDomainRun(state, startedState, 'order_details');
      while (detailsQueue.length > 0) {
        const item = detailsQueue.shift()!;
        try {
          await processOrderDetailsBatch(
            runState, settings, scope, boundTab, origin,
            item.rows, 0,
            {
              total: item.total,
              uploadedBefore: detailsUploaded,
              pendingAfterPage: item.pendingAfterPage,
              preservedFailedOrderIds: [...detailsFailedOrderIds],
              scheduleContinuation: item.scheduleContinuation,
            },
          );
          const afterDetails = await orderSyncStateStore.read();
          (afterDetails.orderProgress?.domains.order_details.failedOrderIds ?? [])
            .forEach((orderId) => detailsFailedOrderIds.add(orderId));
          detailsUploaded = Math.max(
            detailsUploaded,
            afterDetails.orderProgress?.domains.order_details.uploaded ?? detailsUploaded,
          );
        } catch (error) {
          await recordOrderSyncRuntimeLog('order_details', 'queue_failed', 'failed', '订单详情页队列处理异常退出。', {
            stage: 'order_details_page_queue',
            error: error instanceof Error ? sanitizeDiagnosticText(error.message).slice(0, 240) : String(error),
          });
          if (await isOrderSyncScopeCurrent(runState)) await deferOrderDomainAlarm('order_details');
          break;
        }
      }
    } finally {
      detailsQueueRunning = false;
      releaseRun();
    }
  };

  const enqueueDetailsPage = (page: OrderListPage, total: number, pendingAfterPage: number): void => {
    if (page.rows.length === 0) return;
    detailsQueue.push({ rows: page.rows, total, pendingAfterPage, scheduleContinuation: !page.hasMore });
    if (detailsDrainPromise) return;
    detailsDrainPromise = drainDetailsQueue().catch(async (error) => {
      await recordOrderSyncRuntimeLog('order_details', 'queue_failed', 'failed', '订单详情页队列启动异常退出。', {
        stage: 'order_details_page_queue',
        error: error instanceof Error ? sanitizeDiagnosticText(error.message).slice(0, 240) : String(error),
      });
    }).finally(() => { detailsDrainPromise = null; });
  };

  // ── order_history 队列（与物流同模式，N+1 逐单历史）──
  const historyFailedOrderIds = new Set<string>();
  const historyQueue: Array<{
    rows: OrderListRow[];
    total: number;
    pendingAfterPage: number;
    scheduleContinuation: boolean;
  }> = [];
  let historyQueueRunning = false;
  let historyDrainPromise: Promise<void> | null = null;
  let historyUploaded = 0;

  const drainHistoryQueue = async (): Promise<void> => {
    if (historyQueueRunning) return;
    historyQueueRunning = true;
    const releaseRun = orderRunCoordinator.reserve('order_history');
    try {
      const startedState = await beginOrderDomainRun('order_history', trigger);
      const runState = withCurrentOrderDomainRun(state, startedState, 'order_history');
      while (historyQueue.length > 0) {
        const item = historyQueue.shift()!;
        try {
          await processOrderHistoryBatch(
            runState, settings, scope, boundTab, origin,
            item.rows, 0,
            {
              total: item.total,
              uploadedBefore: historyUploaded,
              pendingAfterPage: item.pendingAfterPage,
              preservedFailedOrderIds: [...historyFailedOrderIds],
              scheduleContinuation: item.scheduleContinuation,
            },
          );
          const afterHistory = await orderSyncStateStore.read();
          (afterHistory.orderProgress?.domains.order_history.failedOrderIds ?? [])
            .forEach((orderId) => historyFailedOrderIds.add(orderId));
          historyUploaded = Math.max(
            historyUploaded,
            afterHistory.orderProgress?.domains.order_history.uploaded ?? historyUploaded,
          );
        } catch (error) {
          await recordOrderSyncRuntimeLog('order_history', 'queue_failed', 'failed', '订单历史页队列处理异常退出。', {
            stage: 'order_history_page_queue',
            error: error instanceof Error ? sanitizeDiagnosticText(error.message).slice(0, 240) : String(error),
          });
          if (await isOrderSyncScopeCurrent(runState)) await deferOrderDomainAlarm('order_history');
          break;
        }
      }
    } finally {
      historyQueueRunning = false;
      releaseRun();
    }
  };

  const enqueueHistoryPage = (page: OrderListPage, total: number, pendingAfterPage: number): void => {
    if (page.rows.length === 0) return;
    historyQueue.push({ rows: page.rows, total, pendingAfterPage, scheduleContinuation: !page.hasMore });
    if (historyDrainPromise) return;
    historyDrainPromise = drainHistoryQueue().catch(async (error) => {
      await recordOrderSyncRuntimeLog('order_history', 'queue_failed', 'failed', '订单历史页队列启动异常退出。', {
        stage: 'order_history_page_queue',
        error: error instanceof Error ? sanitizeDiagnosticText(error.message).slice(0, 240) : String(error),
      });
    }).finally(() => { historyDrainPromise = null; });
  };

  const pagePipeline = async (page: OrderListPage): Promise<void> => {
    const total = page.totalRows ?? Math.max(page.fetchedRows, uploaded + page.rows.length);
    const logisticsRows = page.allRows ?? page.rows;
    const futureScanPending = page.hasMore ? Math.max(0, total - page.fetchedRows) : 0;
    await recordOrderSyncRuntimeLog('orders', 'page_pipeline_started', 'started', '订单列表分页读取完成，开始同步本页；物流由独立消费者异步处理。', {
      stage: 'order_page_pipeline',
      page: page.page,
      pageCount: page.pageCount,
      requestOffset: page.requestOffset,
      logicalOffset: page.logicalOffset,
      rowCount: page.rows.length,
      fetchedRows: page.fetchedRows,
      totalRows: page.totalRows,
      hasMore: page.hasMore,
    });
    await recordOrderProgress('orders', {
      listPhase: 'processing',
      listPage: page.page,
      listPageCount: page.pageCount,
      listRowsFetched: page.fetchedRows,
      listTotalRows: page.totalRows,
      listOffset: page.requestOffset,
      listSearchCursor: page.searchCursor,
      listPaginationType: page.paginationType,
    }, 'running', state, `订单列表第 ${page.page} 页已读取，开始同步本页：${page.rows.length} 单。`, {
      action: 'page_ready_for_sync',
      page: page.page,
      pageCount: page.pageCount,
      rowCount: page.rows.length,
      fetchedRows: page.fetchedRows,
      totalRows: page.totalRows,
    });

    const pageCapturedAt = new Date().toISOString();
    const pageEntries = page.rows.map((entry, index) => ({
        key: entry.orderId,
        displayId: entry.orderId,
        index: Math.max(0, page.fetchedRows - page.rows.length) + index + 1,
        process: async () => {
          await uploadOrderSyncDumpGuarded(settings, scope, createOrderSyncDump({
            domain: 'orders',
            endpoint: orderUrl,
            method: 'POST',
            request: { body: createOrderListRequestBody({ offset: page.requestOffset, count: ORDER_LIST_PAGE_SIZE, searchCursor: page.searchCursor, paginationType: page.paginationType }) },
            response: { status: entry.status, body: entry.row },
            createdAt: pageCapturedAt,
            mainOrderId: entry.orderId,
          }));
        },
      }));
    let pageProcessed = 0;
    for (let chunkStart = 0; chunkStart < pageEntries.length; chunkStart += ORDER_DOMAIN_BATCH_SIZE) {
      const chunk = pageEntries.slice(chunkStart, chunkStart + ORDER_DOMAIN_BATCH_SIZE);
      await processOrderDomainBatch(
        state,
        'orders',
        chunk,
        0,
        0,
        null,
        {
          total,
          uploadedBefore: uploaded + pageProcessed,
          // `pending` is the durable upload queue. Rows that have not been
          // scanned yet are represented by listRowsFetched/listTotalRows and
          // must not be reported as if every server order needed uploading.
          pendingAfterPage: 0,
          preservedFailedOrderIds: [...failedOrderIds],
          scheduleContinuation: false,
        },
      );
      const afterChunk = await orderSyncStateStore.read();
      const chunkFailed = new Set(afterChunk.orderProgress?.domains.orders.failedOrderIds ?? []);
      chunkFailed.forEach((orderId) => failedOrderIds.add(orderId));
      const currentChunkFailed = chunk.filter((entry) => chunkFailed.has(entry.key)).length;
      pageProcessed += Math.max(0, chunk.length - currentChunkFailed);
    }

    const afterOrders = await orderSyncStateStore.read();
    const pageFailed = new Set(afterOrders.orderProgress?.domains.orders.failedOrderIds ?? []);
    pageFailed.forEach((orderId) => failedOrderIds.add(orderId));
    uploaded += pageProcessed;

    if (logisticsRows.length > 0 && await isOrderSyncScopeCurrent(state) && isOrderDomainRunCurrent('orders', state)) {
      await recordOrderSyncRuntimeLog('orders', 'page_logistics_enqueued', 'recorded', '订单本页已完成生产，交给独立物流消费者处理。', {
        stage: 'order_page_pipeline',
        page: page.page,
        orderCount: logisticsRows.length,
        selectedOrderCount: page.rows.length,
        consumer: 'logistics',
      });
      enqueueLogisticsPage({ ...page, rows: logisticsRows }, total, futureScanPending);
      // order_details 和 order_history 与物流相同（N+1 模式），也在此处入队。
      enqueueDetailsPage({ ...page, rows: logisticsRows }, total, futureScanPending);
      enqueueHistoryPage({ ...page, rows: logisticsRows }, total, futureScanPending);
      await recordOrderSyncRuntimeLog('orders', 'page_settlement_deferred', 'skipped', '结算接口是全局分页接口，没有订单号过滤参数，本订单页不重复发起结算查询。', {
        stage: 'order_page_pipeline',
        page: page.page,
        reason: 'statement_list_is_global',
      });
    } else if (logisticsRows.length > 0) {
      await recordOrderSyncRuntimeLog('orders', 'page_logistics_skipped', 'skipped', '订单页处理后同步作用域已变化，跳过本页物流查询。', {
        stage: 'order_page_pipeline',
        page: page.page,
        reason: 'sync_scope_changed',
      });
    }

    const pending = failedOrderIds.size;
    await recordOrderProgress('orders', {
      total,
      covered: 0,
      uploaded,
      pending,
      failed: failedOrderIds.size,
      currentOrderId: null,
      currentOrderIndex: null,
      resumeOrderId: [...failedOrderIds][0] ?? null,
      failedOrderIds: [...failedOrderIds],
      pendingOrderIds: [...failedOrderIds],
      snapshotKeys: page.rows.map((entry) => entry.orderId),
      listPhase: page.hasMore ? 'list_fetching' : 'idle',
      listPage: page.page,
      listPageCount: page.pageCount,
      listRowsFetched: page.fetchedRows,
      listTotalRows: page.totalRows,
      listOffset: page.requestOffset,
      listSearchCursor: page.searchCursor,
      listPaginationType: page.paginationType,
      lastError: failedOrderIds.size > 0 ? afterOrders.orderProgress?.domains.orders.lastError ?? null : null,
    }, pending === 0 && !page.hasMore ? 'ok' : 'running', state, `订单第 ${page.page} 页处理完成：累计成功 ${uploaded} 单，待上传 ${pending} 单，待扫描 ${futureScanPending} 单。`, {
      action: 'page_pipeline_completed',
      page: page.page,
      pageCount: page.pageCount,
      pageUploaded: page.rows.length - pageFailed.size,
      uploaded,
      pending,
      scanPending: futureScanPending,
      failed: failedOrderIds.size,
      nextPage: page.hasMore ? page.page + 1 : null,
    });
    await recordOrderSyncRuntimeLog('orders', 'page_pipeline_completed', 'succeeded', '订单分页流水线处理完成。', {
      stage: 'order_page_pipeline',
      page: page.page,
      pageCount: page.pageCount,
      uploaded,
      pending,
      scanPending: futureScanPending,
      failed: failedOrderIds.size,
      nextPage: page.hasMore ? page.page + 1 : null,
    });
  };
  const drain = async (): Promise<void> => {
    const activeDrains = [logisticsDrainPromise, detailsDrainPromise, historyDrainPromise]
      .filter((promise): promise is Promise<void> => promise !== null);
    await Promise.all(activeDrains);
  };
  return { onPage: pagePipeline, drain };
}


async function handleOrderSyncAlarmOnce(trigger: OrderSyncTrigger): Promise<boolean> {
  const rawState = await orderSyncStateStore.read();
  const state = await orderPollingState();
  if (!state) {
    await recordOrderSyncRuntimeLog('orders', 'poll_skipped', 'skipped', orderPollingGateMessage(rawState, '订单'), orderPollingGateDetails(rawState));
    return false;
  }
  const settings = orderSyncSettingsFor(state);
  const scope = orderSyncScopeFor(state);
  const boundTab = state.boundTab!;
  const reconciliation = await fetchOrderReconciliation(state, settings, scope, 'orders');
  const previous = state.orderProgress?.domains.orders ?? createDefaultOrderProgress().domains.orders;
  const pagePipeline = createOrderPagePipeline(
    state,
    settings,
    scope,
    boundTab,
    boundSellerCenterOrigin(boundTab.url),
    trigger,
  );

  let selection: OrderRoundSelection;
  try {
    selection = await fetchOrderRowsForRound(
      state, settings, scope, reconciliation, previous, pagePipeline.onPage,
    );
  } catch (error) {
    if (error instanceof StopOrderDomainBatch) {
      await recordOrderSyncRuntimeLog('orders', 'poll_stopped', 'skipped', '订单主动轮询因同步作用域变化而停止。', {
        reason: 'sync_scope_changed',
      });
      return false;
    }
    await recordOrderProgress('orders', {
      total: previous.total,
      covered: previous.covered,
      uploaded: previous.uploaded,
      pending: previous.pending,
      failed: previous.failed ?? 0,
      currentOrderId: previous.currentOrderId ?? null,
      currentOrderIndex: previous.currentOrderIndex ?? null,
      resumeOrderId: previous.resumeOrderId ?? null,
      failedOrderIds: previous.failedOrderIds ?? [],
      snapshotKeys: previous.snapshotKeys ?? [],
      pendingOrderIds: previous.pendingOrderIds ?? [],
      orderListCheckpoint: previous.orderListCheckpoint ?? null,
      ...resetOrderListProgress(),
      lastError: error instanceof Error ? error.message : String(error),
    }, 'partial', state);
    await scheduleOrderDomainRetryAfterListFailure('orders', state);
    return false;
  } finally {
    await pagePipeline.drain();
  }
  if (selection.streamed) {
    const streamedState = await orderSyncStateStore.read();
    const streamedRow = streamedState.orderProgress?.domains.orders;
    if ((streamedRow?.listRowsFetched ?? 0) === 0) {
      const message = '订单列表本页返回 0 行，保留已有断点并等待下一轮重试。';
      await recordOrderProgress('orders', preserveOrderDomainProgressAfterEmptyList(previous, message), 'partial', state, message, {
        action: 'list_empty',
        streamed: true,
      });
      await scheduleOrderDomainRetryAfterListFailure('orders', state);
      return true;
    }
    const streamedOrderStatus = streamedRow?.syncRunStatus === 'running' ? 'running'
      : streamedRow?.syncRunStatus === 'partial_failed' || streamedRow?.lastError ? 'partial'
        : 'ok';
    await recordOrderProgress('orders', {
      syncStrategy: selection.strategy,
      reconcileStatus: selection.reconcileStatus,
      serverTotal: selection.serverTotal,
      covered: selection.serverTotal ?? streamedRow?.covered ?? 0,
      auditOffset: selection.nextAuditOffset ?? null,
      ...(streamedRow?.pending === 0 && (streamedRow?.failed ?? 0) === 0 && selection.checkpoint
        ? { orderListCheckpoint: selection.checkpoint }
        : {}),
      lastReconciledAt: reconciliation ? new Date().toISOString() : null,
    }, streamedOrderStatus, state, selection.strategy === 'incremental'
      ? '订单采用本地 checkpoint 增量分页同步：本轮按页处理新增、热区和历史巡检。'
      : selection.strategy === 'repair'
        ? '订单进入精确修复：读取当前列表并按服务端存在性补齐缺口。'
        : '订单采用分页全量同步。', {
      action: selection.strategy === 'incremental' ? 'incremental_selected' : selection.strategy === 'repair' ? 'repair_selected' : 'full_selected',
      strategy: selection.strategy,
      serverTotal: selection.serverTotal,
      streamed: true,
    });
    await recordOrderSyncRuntimeLog('orders', 'page_pipeline_finished', streamedRow?.pending ? 'failed' : 'succeeded', streamedRow?.pending
      ? '订单分页流水线结束，但仍有失败订单等待续传。'
      : '订单分页流水线结束，所有订单页已处理。', {
      stage: 'order_page_pipeline',
      total: streamedRow?.total ?? 0,
      uploaded: streamedRow?.uploaded ?? 0,
      pending: streamedRow?.pending ?? 0,
      failed: streamedRow?.failed ?? 0,
    });
    if ((streamedRow?.pending ?? 0) > 0 || (streamedRow?.failed ?? 0) > 0) {
      await scheduleOrderDomainContinuation('orders', false, false);
    }
    return true;
  }
  let rows = selection.rows;
  if (!rows.length) {
    if (selection.strategy === 'incremental' || (selection.strategy === 'repair' && selection.checkpoint?.total === 0)) {
      // 增量轮次没有新增/热区订单时，仍然保留服务端总数；否则 popup 会把
      // total=0 解释成“尚未开始”，从而出现已完成进度反复归零的假象。
      const stableTotal = Math.max(0, selection.serverTotal ?? previous.total ?? 0);
      await recordOrderProgress('orders', {
        total: stableTotal,
        covered: stableTotal,
        uploaded: 0,
        pending: 0,
        failed: 0,
        currentOrderId: null,
        currentOrderIndex: null,
        resumeOrderId: null,
        failedOrderIds: [],
        pendingOrderIds: [],
        snapshotKeys: [],
        ...(selection.checkpoint ? { orderListCheckpoint: selection.checkpoint } : {}),
        lastError: null,
        auditOffset: selection.nextAuditOffset ?? null,
        ...resetOrderListProgress(),
      }, 'ok', state, '订单本轮无新增或热区数据需要刷新。', {
        action: 'incremental_noop',
        serverTotal: selection.serverTotal,
      });
      await scheduleNextOrderDomainRound('orders');
      return false;
    }
    const message = '订单域轮询返回 0 行：bound-page order/list 解析为空（schema 校验失败 / TikTok 返回空 / 解析异常）。';
    await recordOrderProgress('orders', preserveOrderDomainProgressAfterEmptyList(previous, message), 'partial', state, message, {
      action: 'list_empty',
    });
    await scheduleOrderDomainRetryAfterListFailure('orders', state);
    return false;
  }
  await recordOrderProgress('orders', {
    syncStrategy: selection.strategy,
    reconcileStatus: selection.reconcileStatus,
    serverTotal: selection.serverTotal,
    auditOffset: selection.nextAuditOffset ?? null,
    lastReconciledAt: reconciliation ? new Date().toISOString() : null,
  }, 'running', state, selection.strategy === 'incremental'
    ? `订单采用 checkpoint 增量同步，本轮处理 ${rows.length} 单。`
    : selection.strategy === 'repair'
      ? `订单采用精确修复，本轮处理 ${rows.length} 单。`
    : selection.strategy === 'fallback'
      ? '订单边界校验未通过，本轮回退全量同步。'
      : '订单采用全量同步。', {
    action: selection.strategy === 'incremental' ? 'incremental_selected' : selection.strategy === 'repair' ? 'repair_selected' : 'full_selected',
    strategy: selection.strategy,
    serverTotal: selection.serverTotal,
    selectedRows: rows.length,
    fetchedRows: rows.length,
  });
  const orderUrl = tiktokOrderEndpointUrl(boundSellerCenterOrigin(boundTab.url), 'order-list', {
    sellerId: boundTab.sellerId!,
  });
  const orderBody = createOrderListRequestBody({ offset: 0, count: ORDER_LIST_PAGE_SIZE });
  const capturedAt = new Date().toISOString();
  // 订单列表中的状态、金额和时间都是可变字段。后端自然键 upsert 负责幂等，
  // 再作为刷新闸门；后端自然键 upsert 负责幂等，列表结果全部进入本轮刷新。
  await processOrderDomainBatch(
    state,
    'orders',
    rows.map((entry, index) => ({
      key: entry.orderId,
      displayId: entry.orderId,
      index: index + 1,
      process: async () => {
        await uploadOrderSyncDumpGuarded(settings, scope, createOrderSyncDump({
          domain: 'orders',
          endpoint: orderUrl,
          method: 'POST',
          request: { body: orderBody },
          // §2.5 dumps 契约：用真实上游 status（fetchOrderListRows 已存 entry.status），
          // 禁止硬编码 200。
          response: { status: entry.status, body: entry.row },
          createdAt: capturedAt,
          mainOrderId: entry.orderId,
        }));
      },
    })),
    selection.serverTotal ?? 0,
  );
  const completedState = await orderSyncStateStore.read();
  const completedRow = completedState.orderProgress?.domains.orders;
  if (selection.checkpoint && completedRow?.pending === 0 && (completedRow.failed ?? 0) === 0) {
    await recordOrderProgress('orders', { orderListCheckpoint: selection.checkpoint }, 'ok', state);
  }
  return false;
}


/** 物流逐单详情；结算走独立的全局 statement 列表分页。 */
export async function pollOrderDomain(
  domain: Exclude<OrderPollingDomain, 'orders'>,
  trigger: OrderSyncTrigger = 'automatic',
): Promise<void> {
  const result = await orderRunCoordinator.run({
    domain,
    trigger,
    onDeferred: async (reason) => {
      await deferOrderDomainAlarm(domain);
      await recordOrderSyncRuntimeLog(domain, 'alarm_deferred', 'skipped', `${domain} 自动轮询因其他订单域任务占用而延后。`, { reason });
    },
    work: async () => {
      try {
        await beginOrderDomainRun(domain, trigger);
        await recordOrderSyncRuntimeLog(domain, 'alarm_started', 'started', `${domain} 主动轮询开始。`, { trigger });
        await pollOrderDomainOnce(domain);
        const current = await orderSyncStateStore.read();
        const row = current.orderProgress?.domains[domain];
        if (current.boundTab?.sellerId && current.settings.syncToken.trim()
          && isOrderDomainSyncEnabled(current.settings) && shouldScheduleNextOrderDomainRound(row)) {
          await scheduleNextOrderDomainRound(domain);
        }
        await recordOrderSyncRuntimeLog(
          domain,
          'alarm_completed',
          row?.lastError ? 'failed' : 'succeeded',
          row?.lastError ? `${domain} 主动轮询结束，但存在失败。` : `${domain} 主动轮询结束。`,
          {
            trigger,
            status: current.orderProgress?.status ?? 'idle',
            total: row?.total ?? 0,
            uploaded: row?.uploaded ?? 0,
            pending: row?.pending ?? 0,
            lastError: row?.lastError ?? null,
          },
        );
      } catch (error) {
        await recordOrderSyncRuntimeLog(domain, 'alarm_failed', 'failed', `${domain} 主动轮询异常退出。`, {
          trigger,
          error: error instanceof Error ? sanitizeDiagnosticText(error.message).slice(0, 240) : String(error),
        });
        throw error;
      }
    },
  });
  if (result.status === 'skipped') {
    await recordOrderSyncRuntimeLog(domain, 'alarm_skipped', 'skipped', `${domain} 主动轮询跳过：上一轮仍在执行。`, {
      reason: result.reason,
    });
  }
}


async function launchManualOrderDomainSync(retryFailedOnly: boolean): Promise<void> {
  const state = await orderSyncStateStore.read();
  const ALL_MANUAL_DOMAINS: OrderPollingDomain[] = ['orders', 'logistics', 'statements', 'order_details', 'order_history'];
  const domains: OrderPollingDomain[] = retryFailedOnly
    ? ALL_MANUAL_DOMAINS.filter((domain) => {
      const row = state.orderProgress?.domains[domain];
      return Boolean(row && (row.lastError || row.pending > 0 || (row.failed ?? 0) > 0
        || row.syncRunStatus === 'partial_failed' || row.syncRunStatus === 'interrupted'));
    })
    : [...ALL_MANUAL_DOMAINS];
  if (domains.length === 0) return;
  const removeFromDomains = (d: OrderPollingDomain): void => {
    const idx = domains.indexOf(d);
    if (idx >= 0) domains.splice(idx, 1);
  };
  if (domains.includes('orders')) {
    const pagePipelineUsed = await handleOrderSyncAlarm('manual');
    // Streaming order pages drive the logistics/details/history consumer; only the non-streaming
    // path needs standalone discovery.
    if (!pagePipelineUsed) {
      if (domains.includes('logistics')) await pollOrderDomain('logistics', 'manual');
      if (domains.includes('order_details')) await pollOrderDomain('order_details', 'manual');
      if (domains.includes('order_history')) await pollOrderDomain('order_history', 'manual');
    }
    removeFromDomains('orders');
    removeFromDomains('logistics');
    removeFromDomains('order_details');
    removeFromDomains('order_history');
  }
  if (domains.includes('logistics')) await pollOrderDomain('logistics', 'manual');
  if (domains.includes('order_details')) await pollOrderDomain('order_details', 'manual');
  if (domains.includes('order_history')) await pollOrderDomain('order_history', 'manual');
  if (domains.includes('statements')) await pollOrderDomain('statements', 'manual');
}


export async function requestManualOrderDomainSync(retryFailedOnly: boolean): Promise<{ accepted: true }> {
  const current = await orderSyncStateStore.read();
  if (!current.boundTab?.sellerId || !current.settings.syncToken.trim() || !isOrderDomainSyncEnabled(current.settings)) {
    throw new Error('请先绑定店铺并完成订单同步配置。');
  }
  if (!orderShopRegion(current)) {
    throw new Error('店铺地区未配置，无法开始订单同步。请先在 Seller Center 或 TTS-ERP 店铺账号中填写地区代码。');
  }
  const running = (['orders', 'logistics', 'statements', 'order_details', 'order_history'] as const).filter((domain) =>
    current.orderProgress?.domains[domain]?.syncRunStatus === 'running',
  );
  if (running.some((domain) => !orderDomainIsStuck(current.orderProgress?.domains[domain]))) {
    throw new Error('订单相关同步正在运行，请等待当前任务完成。');
  }
  if (running.length > 0) throw new Error('存在卡住的同步任务，请使用“停止卡住任务并重试”进行恢复。');
  const releaseManual = orderRunCoordinator.beginManual({ requireIdle: true });
  if (!releaseManual) throw new Error('后台同步任务正在收尾，请稍后再试。');
  void launchManualOrderDomainSync(retryFailedOnly)
    .catch(reportSchedulerError)
    .finally(releaseManual);
  return { accepted: true };
}


export async function stopStuckOrderDomainAndRetry(domain: OrderDomainKey): Promise<{ accepted: true }> {
  if (orderRunCoordinator.snapshot().manualStartPending) throw new Error('已有手动订单同步操作正在启动，请稍后再试。');
  const current = await orderSyncStateStore.read();
  const row = current.orderProgress?.domains[domain];
  if (!orderDomainIsStuck(row)) throw new Error('该同步任务已有进展，无需停止；请等待它完成。');
  const releaseManual = orderRunCoordinator.beginManual({ requireIdle: false });
  if (!releaseManual) throw new Error('已有手动订单同步操作正在启动，请稍后再试。');
  let retryStartedInBackground = false;
  try {
    const oldRunId = row?.syncRunId;
    const replacementRunId = crypto.randomUUID();
    const now = new Date().toISOString();
    await orderSyncStateStore.update((latest) => {
      const base = latest.orderProgress ?? createDefaultOrderProgress();
      const latestRow = base.domains[domain];
      if (latestRow.syncRunId !== oldRunId || !orderDomainIsStuck(latestRow)) {
        throw new Error('同步状态刚刚更新，请刷新后再操作。');
      }
      return {
        ...latest,
        orderProgress: {
          ...base,
          status: 'partial',
          domains: {
            ...base.domains,
            [domain]: {
              ...latestRow,
              syncRunId: replacementRunId,
              syncRunStatus: 'interrupted',
              lastProgressAt: now,
              lastError: `${domain} 同步长时间没有进度，已由用户停止；将从已保存进度重试。`,
            },
          },
        },
      };
    });
    orderRunCoordinator.stopRun(oldRunId);
    const mainAlarm = domain === 'orders' ? ORDER_SYNC_ALARM : domain === 'logistics' ? LOGISTICS_SYNC_ALARM : domain === 'order_details' ? ORDER_DETAILS_SYNC_ALARM : domain === 'order_history' ? ORDER_HISTORY_SYNC_ALARM : SETTLEMENT_SYNC_ALARM;
    if (typeof chrome.alarms.clear === 'function') {
      await chrome.alarms.clear(mainAlarm);
      await chrome.alarms.clear(continuationAlarmForOrderDomain(domain));
    }
    if (!await orderRunCoordinator.waitForIdle(ORDER_DOMAIN_STOP_WAIT_MS)) {
      throw new Error('旧任务或其他订单域任务仍在收尾。进度已保留，请稍后点“重试失败项”继续。');
    }
    const retry = domain === 'orders' ? handleOrderSyncAlarm('manual') : pollOrderDomain(domain, 'manual');
    retryStartedInBackground = true;
    void retry.catch(reportSchedulerError).finally(releaseManual);
    return { accepted: true };
  } finally {
    if (!retryStartedInBackground) releaseManual();
  }
}


async function pollOrderDomainOnce(domain: Exclude<OrderPollingDomain, 'orders'>): Promise<void> {
  const rawState = await orderSyncStateStore.read();
  const state = await orderPollingState();
  if (!state) {
    await recordOrderSyncRuntimeLog(domain, 'poll_skipped', 'skipped', orderPollingGateMessage(rawState, domain), orderPollingGateDetails(rawState));
    return;
  }
  const settings = orderSyncSettingsFor(state);
  const scope = orderSyncScopeFor(state);
  const boundTab = state.boundTab!;
  const origin = domain === 'statements'
    ? TIKTOK_STATEMENT_API_ORIGIN
    : boundSellerCenterOrigin(boundTab.url);

  let statementRows: StatementPollingRow[] | null = null;
  let orderRows: OrderListRow[] | null = null;
  let logisticsSelection: LogisticsRoundSelection | null = null;
  try {
    statementRows = domain === 'statements' ? await fetchStatementRows(state) : null;
    if (domain === 'logistics') {
      logisticsSelection = await fetchLogisticsRowsForRound(state, settings, scope);
      orderRows = logisticsSelection?.rows ?? (await fetchOrderListRows(state, 'logistics')).rows;
    }
    if (domain === 'order_details' || domain === 'order_history') {
      orderRows = (await fetchOrderListRows(state, domain)).rows;
    }
  } catch (error) {
    if (error instanceof StopOrderDomainBatch) {
      await recordOrderSyncRuntimeLog(domain, 'poll_stopped', 'skipped', `${domain} 主动轮询因同步作用域变化而停止。`, {
        reason: 'sync_scope_changed',
      });
      return;
    }
    const previous = state.orderProgress?.domains[domain] ?? createDefaultOrderProgress().domains[domain];
    await recordOrderProgress(domain, {
      total: previous.total,
      covered: previous.covered,
      uploaded: previous.uploaded,
      pending: previous.pending,
      failed: previous.failed ?? 0,
      currentOrderId: previous.currentOrderId ?? null,
      currentOrderIndex: previous.currentOrderIndex ?? null,
      resumeOrderId: previous.resumeOrderId ?? null,
      failedOrderIds: previous.failedOrderIds ?? [],
      snapshotKeys: previous.snapshotKeys ?? [],
      pendingOrderIds: previous.pendingOrderIds ?? [],
      ...resetOrderListProgress(),
      lastError: error instanceof Error ? error.message : String(error),
    }, 'partial', state);
    await scheduleOrderDomainRetryAfterListFailure(domain, state);
    return;
  }
  const rows = statementRows ?? orderRows ?? [];
  if (domain === 'logistics' && logisticsSelection) {
    await recordOrderProgress('logistics', {
      syncStrategy: logisticsSelection.strategy,
      reconcileStatus: logisticsSelection.reconcileStatus,
      terminalSkipped: logisticsSelection.terminalSkipped,
      lastReconciledAt: new Date().toISOString(),
    }, 'running', state, `物流候选订单已筛选：跳过 ${logisticsSelection.terminalSkipped} 个终态订单，本轮处理 ${rows.length} 单。`, {
      action: 'logistics_candidates_selected',
      strategy: logisticsSelection.strategy,
      terminalSkipped: logisticsSelection.terminalSkipped,
      candidateCount: rows.length,
    });
  } else if (domain === 'logistics') {
    await recordOrderProgress('logistics', {
      syncStrategy: 'fallback',
      reconcileStatus: 'unavailable',
      terminalSkipped: 0,
      lastReconciledAt: null,
    }, 'running', state, '物流统一同步状态不可用，本轮回退订单列表全量发现。', {
      action: 'logistics_full_fallback',
      candidateCount: rows.length,
    });
  }
  if (!rows.length) {
    if (domain === 'logistics' && logisticsSelection) {
      await processLogisticsBatch(
        state,
        settings,
        scope,
        boundTab,
        origin,
        [],
        logisticsSelection.terminalSkipped,
      );
      return;
    }
    const message = `${domain} 域轮询返回 0 行：bound-page ${statementRows ? 'statement/list' : 'order/list'} 解析为空（schema 校验失败 / TikTok 返回空 / 解析异常）。`;
    const previous = state.orderProgress?.domains[domain] ?? createDefaultOrderProgress().domains[domain];
    await recordOrderProgress(domain, preserveOrderDomainProgressAfterEmptyList(previous, message), 'partial', state, message, {
      action: 'list_empty',
    });
    await scheduleOrderDomainRetryAfterListFailure(domain, state);
    return;
  }
  if (domain === 'logistics') {
    await processLogisticsBatch(
      state,
      settings,
      scope,
      boundTab,
      origin,
      orderRows!,
      logisticsSelection?.terminalSkipped ?? 0,
    );
    return;
  }
  if (domain === 'order_details') {
    await processOrderDetailsBatch(
      state,
      settings,
      scope,
      boundTab,
      origin,
      orderRows!,
      0,
    );
    return;
  }
  if (domain === 'order_history') {
    await processOrderHistoryBatch(
      state,
      settings,
      scope,
      boundTab,
      origin,
      orderRows!,
      0,
    );
    return;
  }
  // All order-domain rows are refreshed every round. Existence-only coverage
  // cannot detect mutable settlement corrections; the backend natural-key
  // upserts provide idempotency. The batch processor persists the cursor.
  const pendingRows = statementRows!;
  const capturedAt = new Date().toISOString();
  await processOrderDomainBatch(
    state,
    'statements',
    pendingRows.map((statement, index) => {
      const key = `${statement.statementId}::${statement.statementVersion}`;
      const displayId = `${statement.statementId}@v${statement.statementVersion}`;
      return {
        key,
        displayId,
        index: index + 1,
        process: async () => {
          await uploadOrderSyncDumpGuarded(settings, scope, createOrderSyncDump({
            domain: 'statements',
            endpoint: statement.endpoint,
            method: 'GET',
            request: { params: createStatementListQuery({ from: 0, size: STATEMENT_LIST_PAGE_SIZE }) },
            // §2.5 dumps 契约：用真实上游 status（fetchStatementRows 已存 statement.status），
            // 禁止硬编码 200。
            response: { status: statement.status, body: statement.row },
            createdAt: capturedAt,
            statementId: statement.statementId,
            statementVersion: statement.statementVersion,
          }));
          const detailRefs: StatementSkuDetailRef[] = statement.statementSkuDetailId === undefined
            ? await fetchStatementSkuDetailRefs(state, statement)
            : [{
                statementSkuDetailId: statement.statementSkuDetailId,
                statementId: statement.statementId,
                statementVersion: statement.statementVersion,
              }];
          for (const detailRef of detailRefs) {
          // 结算头上传可能改变绑定、令牌或暂停状态。明细是独立请求，
          // 必须重新确认仍属于同一同步作用域，不能继续向旧配置写数据。
          if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('statements', state)) {
            throw new StopOrderDomainBatch('结算明细请求前同步作用域已变化。');
          }
          const detailUrl = tiktokStatementEndpointUrl(
            origin,
            'statement-transaction-detail',
            { sellerId: boundTab.sellerId!, region: orderShopRegion(state)! },
            createStatementTransactionDetailQuery({
              statementSkuDetailId: detailRef.statementSkuDetailId,
              statementVersion: detailRef.statementVersion,
            }),
          );
          const requestStartedAt = Date.now();
          let detail: BoundTikTokResponse;
          try {
            detail = await executeTikTokRequestWithTimeout(
              boundTab.tabId, detailUrl, {}, 'GET', ORDER_ITEM_REQUEST_TIMEOUT_MS,
            );
          } catch (error) {
            await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算明细请求异常。', {
              stage: 'statement_detail',
              method: 'GET',
              endpoint: orderTikTokEndpointPath(detailUrl),
              statementId: statement.statementId,
              statementVersion: statement.statementVersion,
              durationMs: Math.max(0, Date.now() - requestStartedAt),
              ...orderTikTokRuntimeExchange('GET', detailUrl, undefined),
              ...orderRequestExceptionDetails(error),
            });
            throw error;
          }
          const detailPayload = isRecord(detail.payload) ? detail.payload : null;
          if (!detail.ok) {
            await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算明细响应失败。', {
              stage: 'statement_detail',
              method: 'GET',
              endpoint: orderTikTokEndpointPath(detailUrl),
              statementId: statement.statementId,
              statementVersion: statement.statementVersion,
              durationMs: Math.max(0, Date.now() - requestStartedAt),
              ...orderTikTokRuntimeExchange('GET', detailUrl, undefined, detail),
              ...orderTikTokResponseDiagnostics(detail),
            });
            if (isTikTokAuthenticationFailure(detail)) {
              await clearOrderBinding(state, 'statement_authentication_failed');
              throw new StopOrderDomainBatch('结算明细请求需要重新登录。');
            }
            throw new Error(orderTikTokFailureSummary('结算明细请求失败', detail));
          }
          if (isTikTokAuthenticationFailure(detail)) {
            await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算明细响应要求重新登录。', {
              stage: 'statement_detail',
              method: 'GET',
              endpoint: orderTikTokEndpointPath(detailUrl),
              statementId: statement.statementId,
              statementVersion: statement.statementVersion,
              failureReason: 'authentication_required',
              durationMs: Math.max(0, Date.now() - requestStartedAt),
              ...orderTikTokRuntimeExchange('GET', detailUrl, undefined, detail),
              ...orderTikTokResponseDiagnostics(detail),
            });
            await clearOrderBinding(state, 'statement_authentication_failed');
            throw new StopOrderDomainBatch('结算明细请求需要重新登录。');
          }
          if (detailPayload === null) {
            await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算明细响应为空。', {
              stage: 'statement_detail',
              method: 'GET',
              endpoint: orderTikTokEndpointPath(detailUrl),
              statementId: statement.statementId,
              statementVersion: statement.statementVersion,
              failureReason: 'empty_payload',
              durationMs: Math.max(0, Date.now() - requestStartedAt),
              ...orderTikTokRuntimeExchange('GET', detailUrl, undefined, detail),
              ...orderTikTokResponseDiagnostics(detail),
            });
            throw new Error(`结算明细响应为空（${nullPayloadDiagnostic(detail)}）`);
          }
          const businessFailure = tiktokBusinessFailure(detailPayload, '结算明细');
          if (businessFailure !== null) {
            await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算明细业务响应失败。', {
              stage: 'statement_detail',
              method: 'GET',
              endpoint: orderTikTokEndpointPath(detailUrl),
              statementId: statement.statementId,
              statementVersion: statement.statementVersion,
              failureReason: 'business_code',
              durationMs: Math.max(0, Date.now() - requestStartedAt),
              ...orderTikTokRuntimeExchange('GET', detailUrl, undefined, detail),
              ...orderTikTokResponseDiagnostics(detail),
            });
            throw new Error(businessFailure);
          }
          const parsedDetail = StatementTransactionDetailResponseSchema.safeParse(detailPayload);
          if (!parsedDetail.success) {
            await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'failed', '结算明细响应结构校验失败。', {
              stage: 'statement_detail',
              method: 'GET',
              endpoint: orderTikTokEndpointPath(detailUrl),
              statementId: statement.statementId,
              statementVersion: statement.statementVersion,
              failureReason: 'schema_validation',
              schema: 'StatementTransactionDetailResponseSchema',
              schemaError: sanitizeDiagnosticText(parsedDetail.error.message).slice(0, 240),
              durationMs: Math.max(0, Date.now() - requestStartedAt),
              ...orderTikTokRuntimeExchange('GET', detailUrl, undefined, detail),
              ...orderTikTokResponseDiagnostics(detail),
            });
            throw new Error(`结算明细响应 schema 校验失败：${parsedDetail.error.message}`);
          }
          const detailRecord = parsedDetail.data.data.sku_record;
          if (detailRecord.statement_id !== detailRef.statementId
            || detailRecord.statement_version !== detailRef.statementVersion
            || detailRecord.statement_sku_detail_id !== detailRef.statementSkuDetailId) {
            throw new Error(
              `结算明细身份不匹配：expected ${detailRef.statementId}@${detailRef.statementVersion}`
              + `/${detailRef.statementSkuDetailId}, received ${detailRecord.statement_id}`
              + `@${detailRecord.statement_version}/${detailRecord.statement_sku_detail_id}`,
            );
          }
          await recordOrderSyncRuntimeLog('statements', 'tiktok_request', 'succeeded', '结算明细响应已解析。', {
            stage: 'statement_detail',
            method: 'GET',
            endpoint: orderTikTokEndpointPath(detailUrl),
            statementId: statement.statementId,
            statementVersion: statement.statementVersion,
            durationMs: Math.max(0, Date.now() - requestStartedAt),
            ...orderTikTokRuntimeExchange('GET', detailUrl, undefined, detail),
            ...orderTikTokResponseDiagnostics(detail),
          });
          if (!await isOrderSyncScopeCurrent(state) || !isOrderDomainRunCurrent('statements', state)) {
            throw new StopOrderDomainBatch('结算明细上传前同步作用域已变化。');
          }
          await uploadOrderSyncDumpGuarded(settings, scope, createOrderSyncDump({
            domain: 'statements',
            endpoint: detailUrl,
            method: 'GET',
            request: {},
            // §2.5 dumps 契约：禁止硬编码 status: 200。
            response: { status: detail.status, body: detailPayload },
            createdAt: capturedAt,
            statementId: statement.statementId,
            statementVersion: statement.statementVersion,
          }));
          }
        },
      };
    }),
    0,
    0,
    null,
  );
}


/**
 * 统一 ensure 三个「依赖绑定状态」的订单域 alarm。
 *
 * 为什么必须有这个函数：`ensureBoundAlarm` 在**无绑定**时会 `chrome.alarms.clear(name)`。
 * 而这三个 alarm 原来只在服务 worker 启动时 ensure 一次 —— 若启动那一刻绑定尚未就绪
 * （全新安装 / 绑定前重启 / SW 被回收后重建），它们会被清掉，**用户之后手动绑定也没人
 * 重建**，于是订单/物流/结算轮询永不触发、`chrome_sync.*` 恒 0 行，且完全静默。
 * 2026-09-11 排查到这一形态（与心跳 alarm 丢失同类）。
 *
 * 因此在「绑定成功」与「每次心跳」两处都调用它（幂等：已有主轮次或续传 alarm 时直接返回）。
 */
export async function ensureBoundDomainAlarms(
  initialSyncTrigger: InitialOrderSyncTrigger = 'extension_startup',
): Promise<void> {
  await ensureOrderSyncAlarm();
  await ensureLogisticsSyncAlarm();
  await ensureSettlementSyncAlarm();
  await ensureOrderDetailsSyncAlarm();
  await ensureOrderHistorySyncAlarm();
  // 启动 3 秒探活轮询（setInterval，非 chrome.alarms）
  startHealthPolling(
    async () => {
      const state = await orderSyncStateStore.read();
      return state.settings.syncBaseUrl?.trim() || undefined;
    },
    (healthy, healthState) => {
      void handleTtsErpHealthStateChange(healthy, healthState).catch(reportSchedulerError);
    },
  );
  void maybeStartInitialOrderDomainSync(initialSyncTrigger).catch(() => undefined);
}

// ─── tts-erp /healthz 探活 ─────────────────────────────────────────

/**
 * 探活状态变化回调。由 startHealthPolling 的 onStateChange 触发。
 * 记 runtime log，恢复时触发一轮同步。
 */
async function handleTtsErpHealthStateChange(
  healthy: boolean,
  healthState: TtsErpHealthState,
): Promise<void> {
  if (!healthy) {
    await recordOrderSyncRuntimeLog('all', 'tts_erp_unreachable', 'failed',
      'tts-erp 服务不可达，订单同步已暂停。等待恢复后自动继续。', {
        ttsErpHealthy: false,
        ttsErpLastError: healthState.lastError,
        ttsErpConsecutiveFailures: healthState.consecutiveFailures,
      });
  } else {
    await recordOrderSyncRuntimeLog('all', 'tts_erp_recovered', 'succeeded',
      'tts-erp 服务已恢复，订单同步将自动继续。', {
        ttsErpHealthy: true,
      });
    // 恢复后立即触发一轮同步
    void maybeStartInitialOrderDomainSync('configuration_ready').catch(() => undefined);
  }
}

/** 停止探活轮询。解绑时调用。 */
export function stopTtsErpHealthPolling(): void {
  stopHealthPolling();
}


export async function ensureOrderDetailsSyncAlarm(): Promise<void> {
  await ensureBoundAlarm(ORDER_DETAILS_SYNC_ALARM, ORDER_DETAILS_SYNC_NEXT_DELAY_MINUTES, 'order_details');
}


export async function ensureOrderHistorySyncAlarm(): Promise<void> {
  await ensureBoundAlarm(ORDER_HISTORY_SYNC_ALARM, ORDER_HISTORY_SYNC_NEXT_DELAY_MINUTES, 'order_history');
}


/** Start the first batch for every order domain as soon as a usable bound
 * session exists. Larger rounds continue through their persisted cursors. */
export async function runInitialOrderDomainSync(
  trigger: InitialOrderSyncTrigger = 'extension_startup',
): Promise<void> {
  const state = await orderPollingState();
  if (!state) return;
  await recordOrderSyncRuntimeLog('all', 'initial_sync_started', 'started', '插件首次启用后订单域主动同步开始。', {
    trigger,
  });
  try {
    const orderPagePipelineUsed = await handleOrderSyncAlarm();
    // Streamed order pages enqueue their own logistics work. Only legacy or
    // incremental paths without a page producer need standalone discovery.
    if (!orderPagePipelineUsed) await pollOrderDomain('logistics');
    await pollOrderDomain('statements');
    // order_details 和 order_history 由 pipeline 自动入队；若 pipeline 未启动则手动触发。
    if (!orderPagePipelineUsed) {
      await pollOrderDomain('order_details');
      await pollOrderDomain('order_history');
    }
    const current = await orderSyncStateStore.read();
    const pendingDomains = (['orders', 'logistics', 'statements'] as const)
      .filter((domain) => !isOrderDomainRoundSettled(current.orderProgress?.domains[domain]));
    // order_details 和 order_history 由 pipeline 自动入队，不在首次同步的 pending 域列表中报告。
    await recordOrderSyncRuntimeLog(
      'all',
      pendingDomains.length === 0 ? 'initial_sync_completed' : 'initial_sync_queued',
      'succeeded',
      pendingDomains.length === 0
        ? '插件首次启用后的订单域主动同步已完成。'
        : '插件首次启用后的订单域首批同步已完成，剩余数据已排队续传。',
      { trigger, pendingDomains },
    );
  } catch (error) {
    await recordOrderSyncRuntimeLog('all', 'initial_sync_failed', 'failed', '插件首次启用后的订单域主动同步异常退出。', {
      trigger,
      error: error instanceof Error ? sanitizeDiagnosticText(error.message).slice(0, 240) : String(error),
    });
    throw error;
  }
}


async function maybeStartInitialOrderDomainSync(trigger: InitialOrderSyncTrigger): Promise<void> {
  const rawState = await orderSyncStateStore.read();
  const state = await orderPollingState();
  if (!state) {
    if (rawState.boundTab && rawState.settings.syncToken.trim() && isOrderDomainSyncEnabled(rawState.settings)) {
      const message = rawState.boundTab.sellerId && !orderShopRegion(rawState)
        ? '首次订单同步已拦截：店铺地区未配置，暂未发起订单接口请求。'
        : '首次订单同步等待 Seller ID 捕获，暂未发起订单接口请求。';
      await recordOrderSyncRuntimeLog('all', 'initial_sync_waiting', 'skipped', message, {
        stage: 'initial_sync',
        ...orderPollingGateDetails(rawState),
      });
    }
    return;
  }
  // MV3 service workers can restart many times per day. An in-memory "started"
  // flag alone would rerun this bootstrap on each restart; only bootstrap a
  // store that has never recorded an order-domain run. Daily alarms and saved
  // checkpoints handle all subsequent startup/resume cases.
  if (state.orderProgress?.lastRunAt) return;
  if (initialOrderDomainSyncPromise) return;
  const scope = [
    state.boundTab?.tabId ?? '',
    state.boundTab?.sellerId ?? '',
    normaliseOrderSyncBaseUrl(state.settings.syncBaseUrl),
    state.settings.syncToken.trim(),
  ].join('|');
  if (initialOrderDomainSyncStartedFor === scope) return;
  initialOrderDomainSyncStartedFor = scope;
  // The run records its own failure event. Keep this detached task from
  // becoming an unhandled rejection if the worker is shutting down.
  const run = runInitialOrderDomainSync(trigger);
  let trackedRun: Promise<void>;
  trackedRun = run.finally(() => {
    if (initialOrderDomainSyncPromise === trackedRun) initialOrderDomainSyncPromise = null;
  });
  initialOrderDomainSyncPromise = trackedRun;
  void trackedRun.catch(() => undefined);
}


export async function ensureOrderSyncAlarm(): Promise<void> {
  await ensureBoundAlarm(ORDER_SYNC_ALARM, ORDER_SYNC_NEXT_DELAY_MINUTES, 'orders');
}


export async function ensureLogisticsSyncAlarm(): Promise<void> {
  await ensureBoundAlarm(LOGISTICS_SYNC_ALARM, LOGISTICS_SYNC_NEXT_DELAY_MINUTES, 'logistics');
}


export async function ensureSettlementSyncAlarm(): Promise<void> {
  await ensureBoundAlarm(SETTLEMENT_SYNC_ALARM, SETTLEMENT_SYNC_NEXT_DELAY_MINUTES, 'statements');
}


/** 订单域三个 alarm 都是一次性 alarm：没绑定就清掉，否则确保下一轮存在。 */
async function ensureBoundAlarm(
  name: string,
  nextDelayMinutes: number,
  domain: OrderPollingDomain,
): Promise<void> {
  const state = await orderSyncStateStore.read();
  const boundTab = state.boundTab;
  if (!boundTab?.sellerId || !isOrderDomainSyncEnabled(state.settings)) {
    if (typeof chrome.alarms.clear === 'function') {
      await chrome.alarms.clear(name);
      await chrome.alarms.clear(continuationAlarmForOrderDomain(domain));
    }
    return;
  }
  const existing = await chrome.alarms.get(name);
  // 兼容旧版本遗留的周期 alarm：发现周期 alarm 时重建为一次性 alarm。
  const legacyPeriodicAlarm = existing?.periodInMinutes !== undefined;
  if (legacyPeriodicAlarm) {
    if (typeof chrome.alarms.clear === 'function') await chrome.alarms.clear(name);
  }
  // 正在处理的批次会在 finally 前安排续传或下一整轮。心跳在此时创建
  // 主 alarm 会同续传竞争，造成同一域无意义的 alarm_skipped 日志。
  if (orderRunCoordinator.isActive(domain)) return;
  const continuation = await chrome.alarms.get(continuationAlarmForOrderDomain(domain));
  if (continuation) return;
  const row = state.orderProgress?.domains[domain];
  const hasCheckpoint = (row?.pending ?? 0) > 0
    || row?.resumeOrderId !== null && row?.resumeOrderId !== undefined
    || (row?.failedOrderIds?.length ?? 0) > 0
    || row?.currentOrderId !== null && row?.currentOrderId !== undefined
    || row?.syncRunStatus === 'running'
    || row?.listPhase === 'list_fetching'
    || row?.listPhase === 'processing';
  if (hasCheckpoint) {
    if (existing && typeof chrome.alarms.clear === 'function') await chrome.alarms.clear(name);
    await chrome.alarms.create(name, { delayInMinutes: ORDER_DOMAIN_CONTINUATION_DELAY_MINUTES });
    return;
  }
  const nextSyncAt = Date.parse(row?.nextSyncAt ?? '');
  if (!legacyPeriodicAlarm && existing
    && (!Number.isFinite(nextSyncAt) || Math.abs(existing.scheduledTime - nextSyncAt) < 60_000)) return;
  if (existing && typeof chrome.alarms.clear === 'function') await chrome.alarms.clear(name);
  await chrome.alarms.create(name, Number.isFinite(nextSyncAt)
    ? { when: Math.max(Date.now() + 1_000, nextSyncAt) }
    : { delayInMinutes: nextDelayMinutes });
}


function orderDomainIsStuck(row: OrderDomainProgressRow | undefined, now = Date.now()): boolean {
  if (row?.syncRunStatus !== 'running' || !row.lastProgressAt) return false;
  const lastProgressAt = Date.parse(row.lastProgressAt);
  return Number.isFinite(lastProgressAt) && now - lastProgressAt >= ORDER_DOMAIN_STUCK_AFTER_MS;
}


function orderDomainIsInFlight(domain: OrderPollingDomain): boolean {
  return orderRunCoordinator.isActive(domain);
}


async function beginOrderDomainRun(
  domain: OrderPollingDomain,
  trigger: OrderSyncTrigger,
): Promise<OrderSyncState> {
  const current = await orderSyncStateStore.read();
  const previous = current.orderProgress.domains[domain];
  // A continuation alarm resumes the same durable run and trigger.
  if (previous.syncRunStatus === 'running' && previous.syncRunId) {
    await recordOrderProgress(domain, { lastProgressAt: new Date().toISOString() }, 'running');
    return orderSyncStateStore.read();
  }
  const now = new Date().toISOString();
  await recordOrderProgress(domain, {
    syncRunId: crypto.randomUUID(),
    syncTrigger: trigger,
    syncRunStatus: 'running',
    lastProgressAt: now,
  }, 'running');
  return orderSyncStateStore.read();
}


function withCurrentOrderDomainRun(
  expectedState: OrderSyncState,
  currentState: OrderSyncState,
  domain: OrderPollingDomain,
): OrderSyncState {
  return {
    ...expectedState,
    orderProgress: {
      ...expectedState.orderProgress,
      domains: {
        ...expectedState.orderProgress.domains,
        [domain]: currentState.orderProgress.domains[domain],
      },
    },
  };
}


function isOrderDomainRunCurrent(domain: OrderPollingDomain, expectedState: OrderSyncState): boolean {
  return orderRunCoordinator.isRunCurrent(expectedState.orderProgress?.domains[domain]?.syncRunId);
}


const boundPageTransport = createChromeBoundPageTransport();


async function executeTikTokRequestWithTimeout(
  tabId: number,
  url: string,
  body: Record<string, unknown>,
  method: 'GET' | 'POST',
  timeoutMs = ORDER_PAGE_REQUEST_TIMEOUT_MS,
): Promise<BoundTikTokResponse> {
  assertTikTokEndpointCircuitClosed(url);
  const controller = new AbortController();
  const release = await tiktokRequestPacer().acquire(controller.signal);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    assertTikTokEndpointCircuitClosed(url);
    const response = await boundPageTransport.request({
      tabId,
      url,
      body,
      signal: controller.signal,
      method,
      requestId: crypto.randomUUID(),
      timeoutMs,
    });
    await noteTikTokEndpointResponse(url, response);
    return response;
  } catch (error) {
    if (timedOut && error instanceof DOMException && error.name === 'AbortError') {
      throw Object.assign(new Error(`Seller Center 页面请求超过 ${timeoutMs}ms 未完成。`), {
        name: 'TikTokRequestTimeoutError',
        timeoutMs,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    release();
  }
}

async function uploadOrderSyncDumpGuarded(
  ...args: Parameters<typeof uploadOrderSyncDump>
): Promise<Awaited<ReturnType<typeof uploadOrderSyncDump>>> {
  if (tiktokEndpointCircuitOpen) {
    throw new StopOrderDomainBatch('TikTok 接口连续返回 401/404，已停止向下游 TTS-ERP 上传；需要人工排查后恢复。');
  }
  return uploadOrderSyncDump(...args);
}

export async function probeSellerIdentityInBoundPage(tabId: number): Promise<{
  identity: SellerIdentityResponseData;
  requestUrl: string;
  response: BoundTikTokResponse;
}> {
  const requestUrl = tiktokSellerIdentityEndpointUrl();
  const response = await executeTikTokRequestWithTimeout(
    tabId,
    requestUrl,
    {},
    'GET',
    SELLER_IDENTITY_PROBE_TIMEOUT_MS,
  );
  const identity = response.ok ? parseSellerIdentityResponse(response.payload) : null;
  if (!identity) {
    throw Object.assign(new Error('Seller Center 店铺信息接口未返回可用身份信息。'), {
      name: 'SellerIdentityProbeResponseError',
      response,
    });
  }
  return { identity, requestUrl, response };
}


function isTikTokAuthenticationFailure(response: BoundTikTokResponse): boolean {
  return response.status === 401 || response.status === 403 || isTikTokLoginRequiredResponse(response.payload);
}




function tiktokResponseDiagnostic(status: number, payload: unknown): Record<string, unknown> {
  const body = isRecord(payload) ? payload : {};
  const code = body.code ?? body.errorCode ?? body.error_code;
  const rawMessage = body.message ?? body.msg ?? body.detail;
  return {
    httpStatus: status,
    responseFields: summarizeRuntimeValueShape(body).fields,
    ...(typeof code === 'number' && Number.isFinite(code) ? { serverCode: String(code) } : {}),
    ...(typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? { serverCode: code } : {}),
    ...(typeof rawMessage === 'string' && rawMessage.trim()
      ? { serverMessage: sanitizeDiagnosticText(rawMessage.trim().slice(0, 240)) }
      : {}),
  };
}


/**
 * 空 payload 诊断（2026-09-14 tts-erp 侧排查）：logistic_detail / statement detail
 * 抓取返回非 JSON 或空 body 时 payload=null，此时上传空 dump 只会让服务端记
 * empty_response 并被按 RETRYABLE 无限重试（tts-erp prod 353 条 logistics
 * parse_error 全由此产生）。payload==null 时不上传，记失败并带诊断字段。
 */
function nullPayloadDiagnostic(detail: BoundTikTokResponse): string {
  const parts = [`HTTP ${detail.status}`];
  if (detail.responseReadError) parts.push(detail.responseReadError);
  if (typeof detail.responseTextLength === 'number') parts.push(`${detail.responseTextLength}B`);
  if (detail.responseContentType) parts.push(detail.responseContentType);
  return parts.join(', ');
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}




