export type TikTokRequestMode = 'page_proxy' | 'main_execute_script' | 'worker_fetch';

export interface BoundTikTokResponse {
  ok: boolean;
  status: number;
  payload: unknown;
  responseText?: string;
  /** Character count retained even when callers choose not to persist the raw body. */
  responseTextLength?: number;
  /** Which authenticated-page execution path produced this response. */
  requestMode?: TikTokRequestMode;
  responseContentType?: string;
  responseReadError?: string;
  /** A timeout owned by the authenticated page, not the extension worker. */
  transportError?: 'timeout';
  timings?: {
    pageFetchDurationMs: number;
    responseReadDurationMs: number;
    responseParseDurationMs: number;
  };
}

export interface SellerPageRequestCoordination {
  storageKey: string;
  requestId: string;
  leaseMs: number;
}

/** Self-contained: Chrome serializes this function into the authenticated MAIN world. */
export async function fetchTikTokResponse(
  requestUrl: string,
  requestBody: Record<string, unknown>,
  method: 'GET' | 'POST' = 'POST',
  signalOrTimeoutMs?: AbortSignal | number | null,
  timeoutMs?: number | null,
  parseResponse = true,
  coordination?: SellerPageRequestCoordination,
): Promise<BoundTikTokResponse> {
  const pageStartedAt = Date.now();
  let coordinationStarted = false;
  if (coordination && typeof globalThis.localStorage !== 'undefined') {
    try {
      const parsed = JSON.parse(globalThis.localStorage.getItem(coordination.storageKey) ?? '{}') as {
        activeRequests?: Record<string, number>;
        lastActivityAt?: number;
        refreshClaimUntil?: number;
      };
      if (typeof parsed.refreshClaimUntil === 'number' && parsed.refreshClaimUntil > pageStartedAt) {
        throw Object.assign(new Error('Seller Center 页面即将刷新，请求将在刷新后重试。'), {
          name: 'SellerPageRefreshClaimedError',
        });
      }
      const activeRequests = typeof parsed.activeRequests === 'object' && parsed.activeRequests !== null
        ? Object.fromEntries(Object.entries(parsed.activeRequests)
          .filter(([, expiresAt]) => typeof expiresAt === 'number' && expiresAt > pageStartedAt)) : {};
      activeRequests[coordination.requestId] = pageStartedAt + coordination.leaseMs;
      globalThis.localStorage.setItem(coordination.storageKey, JSON.stringify({
        activeRequests,
        lastActivityAt: typeof parsed.lastActivityAt === 'number' ? parsed.lastActivityAt : 0,
        refreshClaimUntil: typeof parsed.refreshClaimUntil === 'number' ? parsed.refreshClaimUntil : 0,
      }));
      coordinationStarted = true;
    } catch (error) {
      if (error instanceof Error && error.name === 'SellerPageRefreshClaimedError') throw error;
      // The request still runs; refresh claiming fails closed when shared storage is unavailable.
    }
  }
  // The MAIN-world executeScript path cannot receive undefined in its args
  // array. It passes null for this unused AbortSignal slot instead.
  const signal = typeof signalOrTimeoutMs === 'number' || signalOrTimeoutMs === null
    ? undefined : signalOrTimeoutMs;
  const pageTimeoutMs = typeof signalOrTimeoutMs === 'number'
    ? signalOrTimeoutMs : timeoutMs ?? undefined;
  const pageController = pageTimeoutMs !== undefined && Number.isFinite(pageTimeoutMs) && pageTimeoutMs > 0
    ? new AbortController()
    : undefined;
  const requestSignal = pageController?.signal ?? signal;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let callerAbortHandler: (() => void) | undefined;
  if (pageController && signal !== undefined) {
    callerAbortHandler = () => pageController.abort();
    if (signal.aborted) callerAbortHandler();
    else signal.addEventListener('abort', callerAbortHandler, { once: true });
  }
  if (pageController && pageTimeoutMs !== undefined) {
    timeout = setTimeout(() => {
      timedOut = true;
      pageController.abort();
    }, pageTimeoutMs);
  }
  try {
    const isGet = method === 'GET';
    const response = await globalThis.fetch(requestUrl, {
      method, credentials: 'include', cache: 'no-store',
      ...(isGet ? {} : {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
        body: JSON.stringify(requestBody),
      }),
      ...(requestSignal === undefined ? {} : { signal: requestSignal }),
    });
    const responseReceivedAt = Date.now();
    const transport = { ok: response.ok, status: response.status,
      responseContentType: response.headers.get('content-type') ?? '' };
    let text: string;
    const responseReadStartedAt = responseReceivedAt;
    try {
      text = await response.text();
    } catch {
      const timings = {
        pageFetchDurationMs: Math.max(0, responseReceivedAt - pageStartedAt),
        responseReadDurationMs: Math.max(0, Date.now() - responseReadStartedAt),
        responseParseDurationMs: 0,
      };
      if (timedOut) return { ok: false, status: 0, payload: null, transportError: 'timeout', timings };
      // §2.5 dumps 契约：response-read-failed 必须 NOT 返回 ok:true，否则 plugin 误推进度。
      return { ...transport, ok: false, payload: null, responseReadError: 'response-read-failed', timings };
    }
    const responseReadDurationMs = Math.max(0, Date.now() - responseReadStartedAt);
    if (!parseResponse) {
      return {
        ...transport,
        payload: null,
        responseText: text,
        responseTextLength: text.length,
        timings: {
          pageFetchDurationMs: Math.max(0, responseReceivedAt - pageStartedAt),
          responseReadDurationMs,
          responseParseDurationMs: 0,
        },
      };
    }
    const responseParseStartedAt = Date.now();
    try {
      const payload = JSON.parse(text) as unknown;
      return {
        ...transport,
        payload,
        responseTextLength: text.length,
        timings: {
          pageFetchDurationMs: Math.max(0, responseReceivedAt - pageStartedAt),
          responseReadDurationMs,
          responseParseDurationMs: Math.max(0, Date.now() - responseParseStartedAt),
        },
      };
    } catch {
      // §2.5 dumps 契约：response-not-json（parse 失败）必须 NOT 返回 ok:true；
      // 否则 plugin 误把"200 + 垃圾 body"当作成功上报，导致服务端 ingested 错误数据。
      // force ok:false 让所有以 ok 分类的调用者必须先看 responseReadError。
      return {
        ...transport,
        ok: false,
        payload: null,
        responseText: text,
        responseTextLength: text.length,
        responseReadError: 'response-not-json',
        timings: {
          pageFetchDurationMs: Math.max(0, responseReceivedAt - pageStartedAt),
          responseReadDurationMs,
          responseParseDurationMs: Math.max(0, Date.now() - responseParseStartedAt),
        },
      };
    }
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        status: 0,
        payload: null,
        transportError: 'timeout',
        timings: {
          pageFetchDurationMs: Math.max(0, Date.now() - pageStartedAt),
          responseReadDurationMs: 0,
          responseParseDurationMs: 0,
        },
      };
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (callerAbortHandler && signal !== undefined) signal.removeEventListener('abort', callerAbortHandler);
    if (coordinationStarted && coordination && typeof globalThis.localStorage !== 'undefined') {
      try {
        const now = Date.now();
        const parsed = JSON.parse(globalThis.localStorage.getItem(coordination.storageKey) ?? '{}') as {
          activeRequests?: Record<string, number>;
          refreshClaimUntil?: number;
        };
        const activeRequests = typeof parsed.activeRequests === 'object' && parsed.activeRequests !== null
          ? Object.fromEntries(Object.entries(parsed.activeRequests)
            .filter(([id, expiresAt]) => id !== coordination.requestId
              && typeof expiresAt === 'number' && expiresAt > now)) : {};
        globalThis.localStorage.setItem(coordination.storageKey, JSON.stringify({
          activeRequests,
          lastActivityAt: now,
          refreshClaimUntil: typeof parsed.refreshClaimUntil === 'number' ? parsed.refreshClaimUntil : 0,
        }));
      } catch {
        // Expired request leases are pruned by the next request or refresh claimant.
      }
    }
  }
}
