/**
 * Order-sync protocol client for tts-erp /v2/order-sync/* endpoints.
 *
 * Follows the same architecture as analytics-sync-v2 (dump upload + coverage
 * check), but for order/logistics/statement domains from the Chrome extension
 * Seller Center page captures.
 *
 * Protocol contract:
 * - POST /v2/order-sync/has-data — bulk coverage check (which order_ids already synced)
 * - POST /v2/order-sync/dumps   — single dump upload (inline parse on server)
 * - POST /v2/order-sync/reconcile — one reconciliation query for order and logistics state
 */

import {
  HasDataRequestSchema,
  HasDataResponseSchema,
  OrderSyncDumpRequestSchema,
  OrderSyncDumpResponseSchema,
  OrderSyncReconcileRequestSchema,
  OrderSyncReconcileResponseSchema,
  type OrderSyncDomain,
  type HasDataRequest,
  type OrderSyncDumpRequest,
  type OrderSyncReconcileRequest,
  type OrderSyncReconcileResponse,
} from './order-sync-schemas';

export const ORDER_SYNC_PROTOCOL_VERSION = 1;
export const ORDER_SYNC_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
export const ORDER_SYNC_HTTP_TIMEOUT_MS = 20_000;
export const ORDER_SYNC_MAX_RETRY_AFTER_MS = 60_000;

// ─────────────────────────────────────────────────────────────────
// Settings & scope
// ─────────────────────────────────────────────────────────────────

export interface OrderSyncSettings {
  syncBaseUrl: string;
  syncToken: string;
}

export interface OrderSyncScope {
  sellerId: string;
  shopId: string;
}

// ─────────────────────────────────────────────────────────────────
// Error class (mirrors AnalyticsSyncV2Error)
// ─────────────────────────────────────────────────────────────────

export type OrderSyncErrorCode = 'NETWORK' | 'RETRYABLE' | 'PERMANENT' | 'PROTOCOL';

export interface SafeServerDiagnostic {
  operation: 'has-data' | 'dump' | 'reconcile';
  httpStatus: number;
  serverCode?: string;
  serverRequestId?: string;
  responseFields: string[];
}

/** Transport evidence retained on errors so the background log can distinguish
 * proxy/DNS/TLS failures from an HTTP rejection without recording credentials. */
export interface OrderSyncRequestDiagnostics {
  endpoint: string;
  requestId: string;
  attempts: number;
  totalDurationMs: number;
  lastAttemptDurationMs: number;
  transportFailure?: 'network' | 'timeout';
  lastErrorName?: string;
  lastErrorMessage?: string;
}

export class OrderSyncError extends Error {
  public requestDiagnostics?: OrderSyncRequestDiagnostics;

  constructor(
    public readonly code: OrderSyncErrorCode,
    message = '订单同步暂不可用',
    public readonly httpStatus?: number,
    public readonly diagnostic?: SafeServerDiagnostic,
    public readonly operation?: 'has-data' | 'dump' | 'reconcile',
    public readonly transportFailure?: 'network' | 'timeout',
  ) {
    super(message);
    this.name = 'OrderSyncError';
  }
}

function requestEndpoint(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message.slice(0, 240);
  if (typeof error === 'string') return error.slice(0, 240);
  return undefined;
}

function withRequestDiagnostics(
  error: OrderSyncError,
  url: URL,
  requestId: string,
  attempts: number,
  startedAt: number,
  lastAttemptStartedAt: number,
  transportError?: unknown,
): OrderSyncError {
  const lastErrorName = errorName(transportError);
  const lastErrorMessage = errorMessage(transportError);
  error.requestDiagnostics = {
    endpoint: requestEndpoint(url),
    requestId,
    attempts,
    totalDurationMs: Math.max(0, Date.now() - startedAt),
    lastAttemptDurationMs: Math.max(0, Date.now() - lastAttemptStartedAt),
    ...(error.transportFailure === undefined ? {} : { transportFailure: error.transportFailure }),
    ...(lastErrorName === undefined ? {} : { lastErrorName }),
    ...(lastErrorMessage === undefined ? {} : { lastErrorMessage }),
  };
  return error;
}

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type DumpUploadStatus = 'inserted';  // 其他状态作废（strict HTTP 语义下）
// NOTE: DumpUploadStatus 保留为类型文档；当前无 production code 使用它。

export interface HasDataResult {
  domain: OrderSyncDomain;
  covered: Record<string, boolean>;
}

/**
 * `/v2/order-sync/dumps` 成功响应的 `data`。
 *
 * strict HTTP 语义下：HTTP 2xx = 成功（data 仅含 requestId 用于日志追踪）；
 * HTTP 4xx/5xx = 失败（通过 responseError 处理）。
 *
 * 旧字段 `status` / `rowsWritten` / `logId` 已删除（tts-erp 端不再返回）。
 */
export interface DumpResponse {
  requestId?: string;  // 仅用于日志追踪
}

/**
 * Canonical producer for the order-domain dump object. Keeping construction
 * here makes the wire shape reusable by polling and cross-repository contract
 * tests instead of duplicating subtly different inline envelopes.
 */
export function createOrderSyncDump(
  params: {
    domain: OrderSyncDomain;
    endpoint: string;
    method: string;
    request: OrderSyncDumpRequest['dump']['request'];
    response: OrderSyncDumpRequest['dump']['response'];
    createdAt: string;
    mainOrderId?: string;
    statementId?: string;
    statementVersion?: number;
  },
): OrderSyncDumpRequest['dump'] {
  return {
    domain: params.domain,
    endpoint: params.endpoint,
    method: params.method,
    request: params.request,
    response: params.response,
    createdAt: params.createdAt,
    ...(params.mainOrderId === undefined ? {} : { mainOrderId: params.mainOrderId }),
    ...(params.statementId === undefined ? {} : { statementId: params.statementId }),
    ...(params.statementVersion === undefined ? {} : { statementVersion: params.statementVersion }),
  };
}

export type OrderSyncReconcileResult = OrderSyncReconcileResponse['data'];

// ─────────────────────────────────────────────────────────────────
// hasDataBulk — POST /v2/order-sync/has-data
// ─────────────────────────────────────────────────────────────────

export async function hasDataBulk(
  settings: OrderSyncSettings,
  scope: OrderSyncScope,
  domain: OrderSyncDomain,
  ids: string[],
  options: {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    requestId?: string;
    versions?: Record<string, number | number[]>;
  } = {},
): Promise<HasDataResult> {
  const syncToken = settings.syncToken.trim();
  if (!syncToken) {
    throw new OrderSyncError('PERMANENT', '同步令牌未配置', undefined, undefined, 'has-data');
  }
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const requestId = options.requestId ?? crypto.randomUUID();

  const payload: HasDataRequest = {
    scope,
    domain,
    ids,
    ...(options.versions ? { versions: options.versions } : {}),
  };
  HasDataRequestSchema.parse(payload);

  const url = new URL('v2/order-sync/has-data', normaliseBaseUrl(settings.syncBaseUrl));
  const requestStartedAt = Date.now();

  let response: Response;
  try {
    response = await request(fetchImpl, url, {
      method: 'POST',
      headers: {
        ...scopeHeaders(settings),
        'content-type': 'application/json',
        'x-protocol-version': String(ORDER_SYNC_PROTOCOL_VERSION),
        'x-request-id': requestId,
      },
      body: JSON.stringify(payload),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (isAborted(options.signal, error)) throw abortError();
    const syncError = new OrderSyncError(
      'NETWORK', undefined, undefined, undefined, 'has-data', transportFailureKind(error),
    );
    throw withRequestDiagnostics(syncError, url, requestId, 1, requestStartedAt, requestStartedAt, error);
  }

  if (!response.ok) {
    const syncError = await responseError(response, 'has-data');
    throw withRequestDiagnostics(syncError, url, requestId, 1, requestStartedAt, requestStartedAt);
  }
  try {
    return parseHasDataResponse(await response.json(), domain);
  } catch (error) {
    if (error instanceof OrderSyncError) {
      throw withRequestDiagnostics(error, url, requestId, 1, requestStartedAt, requestStartedAt);
    }
    throw error;
  }
}

function parseHasDataResponse(value: unknown, expectedDomain: OrderSyncDomain): HasDataResult {
  const parsed = HasDataResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.code !== 0 || parsed.data.data.domain !== expectedDomain) {
    throw new OrderSyncError('PROTOCOL', 'has-data 响应 envelope 无效');
  }
  const { data } = parsed.data;
  return {
    domain: data.domain,
    covered: data.covered,
  };
}

// ─────────────────────────────────────────────────────────────────
// uploadOrderSyncDump — POST /v2/order-sync/dumps
// ─────────────────────────────────────────────────────────────────

export async function uploadOrderSyncDump(
  settings: OrderSyncSettings,
  scope: OrderSyncScope,
  dump: OrderSyncDumpRequest['dump'],
  options: {
    fetchImpl?: FetchLike;
    sleep?: Sleep;
    signal?: AbortSignal;
    requestId?: string;
  } = {},
): Promise<DumpResponse> {
  const syncToken = settings.syncToken.trim();
  if (!syncToken) {
    throw new OrderSyncError('PERMANENT', '同步令牌未配置', undefined, undefined, 'dump');
  }
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const sleep = options.sleep ?? abortableDelay;
  const requestId = options.requestId ?? crypto.randomUUID();

  const body: OrderSyncDumpRequest = {
    protocolVersion: ORDER_SYNC_PROTOCOL_VERSION,
    requestId,
    scope,
    dump,
  };
  OrderSyncDumpRequestSchema.parse(body);

  // Hoist JSON.stringify to avoid computing it twice (size check + fetch body)
  const bodyStr = JSON.stringify(body);
  const bodySize = new TextEncoder().encode(bodyStr).byteLength;
  if (bodySize > ORDER_SYNC_MAX_BODY_BYTES) {
    throw new OrderSyncError('PERMANENT', undefined, 413, undefined, 'dump', undefined);
  }

  const url = new URL('v2/order-sync/dumps', normaliseBaseUrl(settings.syncBaseUrl));
  const uploadStartedAt = Date.now();
  let lastAttemptStartedAt = uploadStartedAt;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    lastAttemptStartedAt = Date.now();
    let response: Response;
    try {
      response = await request(fetchImpl, url, {
        method: 'POST',
        headers: {
          ...scopeHeaders(settings),
          'content-type': 'application/json',
          'x-protocol-version': String(ORDER_SYNC_PROTOCOL_VERSION),
          'x-request-id': requestId,
        },
        body: bodyStr,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (isAborted(options.signal, error)) throw abortError();
      if (attempt + 1 === 3) {
        const syncError = new OrderSyncError('NETWORK', undefined, undefined, undefined, 'dump', transportFailureKind(error));
        const rootError = error instanceof OrderSyncTransportError ? error.originalError ?? error : error;
        throw withRequestDiagnostics(syncError, url, requestId, attempt + 1, uploadStartedAt, lastAttemptStartedAt, rootError);
      }
      await sleepWithAbort(sleep, retryDelay(attempt), options.signal);
      continue;
    }

    if (response.status === 413) {
      const syncError = new OrderSyncError('PERMANENT', undefined, 413, undefined, 'dump', undefined);
      throw withRequestDiagnostics(syncError, url, requestId, attempt + 1, uploadStartedAt, lastAttemptStartedAt);
    }
    if (response.status === 400) {
      // dumps 的 400 可能来自服务端尚未部署对应域路由或暂时性的契约不一致。
      // 交给上层订单域 pendingOrderIds 队列续传，不能把单条数据判成永久失败。
      const diagnostic = await responseDiagnostic(response, 'dump');
      const syncError = new OrderSyncError('RETRYABLE', undefined, 400, diagnostic, 'dump', undefined);
      throw withRequestDiagnostics(syncError, url, requestId, attempt + 1, uploadStartedAt, lastAttemptStartedAt);
    }
    if (response.status === 429 || response.status >= 500) {
      if (options.signal?.aborted) throw abortError();
      if (attempt + 1 === 3) {
        const syncError = await responseError(response, 'dump');
        throw withRequestDiagnostics(syncError, url, requestId, attempt + 1, uploadStartedAt, lastAttemptStartedAt);
      }
      await sleepWithAbort(
        sleep,
        response.status === 429 ? retryAfterMilliseconds(response.headers.get('retry-after')) : retryDelay(attempt),
        options.signal,
      );
      continue;
    }

    if (!response.ok) {
      const syncError = await responseError(response, 'dump');
      throw withRequestDiagnostics(syncError, url, requestId, attempt + 1, uploadStartedAt, lastAttemptStartedAt);
    }
    try {
      const result = parseDumpResponse(await response.json());
      return result;
    } catch (error) {
      if (error instanceof OrderSyncError) {
        throw withRequestDiagnostics(error, url, requestId, attempt + 1, uploadStartedAt, lastAttemptStartedAt);
      }
      throw error;
    }
  }

  const syncError = new OrderSyncError('RETRYABLE');
  throw withRequestDiagnostics(syncError, url, requestId, 3, uploadStartedAt, lastAttemptStartedAt);
}

/**
 * 解析 `/v2/order-sync/dumps` 成功响应。
 *
 * 硬契约只有 envelope 的 `code === 0`；`data` 字段防御式读取并给默认值。
 * 理由同广告域（`analytics-sync-v2.ts::parseDumpResponse` 的注释）：调用方已确认
 * `response.ok`，2xx 就是「服务端已接受」，响应体不该有能力把成功变成失败。
 * 2026-09-11 事故里本函数按已移除的 `{idempotencyKey, status}` 校验，
 * 会对每一次成功上传抛 PROTOCOL。
 */
function parseDumpResponse(value: unknown): DumpResponse {
  const parsed = OrderSyncDumpResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.code !== 0) {
    throw new OrderSyncError('PROTOCOL', 'dumps 响应 envelope 无效');
  }
  // strict HTTP 语义：HTTP 2xx 即成功，不再解析 status / rowsWritten
  // 仅保留 requestId 用于日志追踪
  return parsed.data.requestId === undefined
    ? {}
    : { requestId: parsed.data.requestId };
}

// ─────────────────────────────────────────────────────────────────
// fetchOrderSyncReconciliation — POST /v2/order-sync/reconcile
// ─────────────────────────────────────────────────────────────────

export async function fetchOrderSyncReconciliation(
  settings: OrderSyncSettings,
  scope: OrderSyncScope,
  reconcileRequest: Omit<OrderSyncReconcileRequest, 'protocolVersion' | 'scope'>,
  options: {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    requestId?: string;
  } = {},
): Promise<OrderSyncReconcileResult> {
  const syncToken = settings.syncToken.trim();
  if (!syncToken) {
    throw new OrderSyncError('PERMANENT', '同步令牌未配置', undefined, undefined, 'reconcile');
  }
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const requestId = options.requestId ?? crypto.randomUUID();

  const payload: OrderSyncReconcileRequest = {
    protocolVersion: ORDER_SYNC_PROTOCOL_VERSION,
    scope,
    ...reconcileRequest,
  };
  OrderSyncReconcileRequestSchema.parse(payload);

  const url = new URL('v2/order-sync/reconcile', normaliseBaseUrl(settings.syncBaseUrl));
  const requestStartedAt = Date.now();

  let response: Response;
  try {
    response = await request(fetchImpl, url, {
      method: 'POST',
      headers: {
        ...scopeHeaders(settings),
        'x-protocol-version': String(ORDER_SYNC_PROTOCOL_VERSION),
        'x-request-id': requestId,
      },
      body: JSON.stringify(payload),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (isAborted(options.signal, error)) throw abortError();
    const syncError = new OrderSyncError(
      'NETWORK', undefined, undefined, undefined, 'reconcile', transportFailureKind(error),
    );
    throw withRequestDiagnostics(syncError, url, requestId, 1, requestStartedAt, requestStartedAt, error);
  }

  if (!response.ok) {
    const syncError = await responseError(response, 'reconcile');
    throw withRequestDiagnostics(syncError, url, requestId, 1, requestStartedAt, requestStartedAt);
  }
  try {
    return parseReconcileResponse(await response.json());
  } catch (error) {
    if (error instanceof OrderSyncError) {
      throw withRequestDiagnostics(error, url, requestId, 1, requestStartedAt, requestStartedAt);
    }
    throw error;
  }
}

function parseReconcileResponse(value: unknown): OrderSyncReconcileResult {
  const parsed = OrderSyncReconcileResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.code !== 0) {
    throw new OrderSyncError('PROTOCOL', 'reconcile 响应 envelope 无效');
  }
  return parsed.data.data;
}

// ─────────────────────────────────────────────────────────────────
// Shared helpers (mirrors analytics-sync-v2 transport primitives)
// ─────────────────────────────────────────────────────────────────

export type FetchLike = typeof fetch;
export type { Sleep } from './async-utils';
import { abortError, abortableDelay, sleepWithAbort, type Sleep } from './async-utils';

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

function scopeHeaders(settings: OrderSyncSettings): HeadersInit {
  const syncToken = settings.syncToken.trim();
  return {
    authorization: `Bearer ${syncToken}`,
    'content-type': 'application/json',
    'x-protocol-version': String(ORDER_SYNC_PROTOCOL_VERSION),
    'x-api-key': syncToken,
  };
}

async function request(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  if (init.signal?.aborted) throw abortError();
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ORDER_SYNC_HTTP_TIMEOUT_MS);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (init.signal?.aborted) throw error;
        throw new OrderSyncTransportError(timedOut ? 'timeout' : 'network', error);
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }
}

class OrderSyncTransportError extends Error {
  constructor(public readonly kind: 'network' | 'timeout', public readonly originalError?: unknown) {
    super('Order sync transport failed');
    this.name = 'OrderSyncTransportError';
  }
}

function transportFailureKind(error: unknown): 'network' | 'timeout' {
  return error instanceof OrderSyncTransportError ? error.kind : 'network';
}

async function responseError(
  response: Response,
  operation: 'has-data' | 'dump' | 'reconcile',
): Promise<OrderSyncError> {
  // 429 (Too Many Requests) 是 transient，与 5xx 同列 RETRYABLE；
  // 原实现把 429 判 PERMANENT 会让查询路径的限流立即放弃同步，
  // 而同文件 upload 路径又会 honor retry-after 走 RETRYABLE —— 行为不一致。
  return new OrderSyncError(
    response.status >= 500 || response.status === 429 ? 'RETRYABLE' : 'PERMANENT',
    undefined,
    response.status,
    await responseDiagnostic(response, operation),
    operation,
  );
}

async function responseDiagnostic(
  response: Response,
  operation: 'has-data' | 'dump' | 'reconcile',
): Promise<SafeServerDiagnostic> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  const body = isRecord(value) ? value : {};
  const responseFields = Object.keys(body)
    .filter((key) => isSafeDiagnosticField(key))
    .sort()
    .slice(0, 16);
  const serverCode = safeDiagnosticScalar(body.code);
  const serverRequestId = safeRequestId(body.requestId);
  return {
    operation,
    httpStatus: response.status,
    ...(serverCode === undefined ? {} : { serverCode }),
    ...(serverRequestId === undefined ? {} : { serverRequestId }),
    responseFields,
  };
}

function retryAfterMilliseconds(value: string | null): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(ORDER_SYNC_MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1_000));
  }
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? 1_000
    : Math.min(ORDER_SYNC_MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
}

function retryDelay(attempt: number): number {
  return 1_000 * (attempt + 1);
}

function normaliseBaseUrl(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

// ─────────────────────────────────────────────────────────────────
// Type guards + small utilities
// ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSafeDiagnosticField(value: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) &&
    !/(token|authorization|cookie|password|secret|credential|api[_-]?key|signature|sign|csrf)/i.test(value)
  );
}

function safeDiagnosticScalar(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function isAborted(signal: AbortSignal | undefined, _error: unknown): boolean {
  return signal?.aborted === true;
}

// abortError, abortableDelay, sleepWithAbort, Sleep: imported from ./async-utils
