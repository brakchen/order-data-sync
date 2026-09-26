export interface RequestRateLimiterOptions {
  intervalMs: number;
  maxInFlight: number;
  /** Reserve slots for requests at or below this priority when they are queued. */
  reservedSlotsForPriority?: {
    maxPriority: number;
    slots: number;
  };
}

/** Accelerated mode targets 5–8 request starts per second. */
export const ACCELERATED_REQUEST_MIN_QPS = 5;
export const ACCELERATED_REQUEST_MAX_QPS = 8;
export const ACCELERATED_REQUEST_INTERVAL_MS = 1_000 / ACCELERATED_REQUEST_MAX_QPS;
export const ACCELERATED_REQUEST_MAX_IN_FLIGHT = 8;
// 0.1.150：删 CURSOR_REQUEST_* 和 createTokenBucketRateLimiter（死件）。
// 2026-09-02 dump-architecture 改造把 /cursor 从「正查」降级成 has-data 预检
// （只返 1 行 true/false），500 QPS / 100 in-flight 的限流器从此再没人 acquire。

export type ReleaseRequestSlot = () => void;

interface PendingRequest {
  resolve: (release: ReleaseRequestSlot) => void;
  reject: (reason: unknown) => void;
  /** 越大越先服务（默认 0）。同优先级保持 FIFO。 */
  priority: number;
  cancelled: boolean;
}

function createAbortError(): DOMException {
  return new DOMException('Request aborted', 'AbortError');
}

/**
 * Spaces request starts while allowing a bounded number of requests to run
 * at once. The limiter is intentionally independent of fetch so it can pace
 * both page-injected TikTok calls and campaign discovery calls.
 */
export function createRequestRateLimiter(options: RequestRateLimiterOptions): {
  /** `priority` 越大越先拿到名额（默认 0，同优先级 FIFO）。 */
  acquire: (priority?: number, signal?: AbortSignal) => Promise<ReleaseRequestSlot>;
} {
  const validMaxInFlight = options.maxInFlight === Number.POSITIVE_INFINITY ||
    (Number.isSafeInteger(options.maxInFlight) && options.maxInFlight >= 1);
  const reserved = options.reservedSlotsForPriority;
  const validReserved = reserved === undefined || (
    Number.isSafeInteger(reserved.maxPriority)
    && Number.isSafeInteger(reserved.slots)
    && reserved.slots >= 1
    && (options.maxInFlight === Number.POSITIVE_INFINITY || reserved.slots <= options.maxInFlight)
  );
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0 ||
    !validMaxInFlight || !validReserved) {
    throw new Error('Invalid request rate limiter options');
  }
  const pending: PendingRequest[] = [];
  let inFlight = 0;
  let nextStartAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pump = (): void => {
    if (timer !== undefined || inFlight >= options.maxInFlight || pending.length === 0) return;
    const wait = Math.max(0, nextStartAt - Date.now());
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        pump();
      }, wait);
      return;
    }
    const reservedIndex = reserved !== undefined && inFlight >= options.maxInFlight - reserved.slots
      ? pending.findIndex((candidate) => candidate.priority <= reserved.maxPriority)
      : -1;
    const request = pending.splice(reservedIndex >= 0 ? reservedIndex : 0, 1)[0]!;
    if (request.cancelled) {
      pump();
      return;
    }
    inFlight += 1;
    nextStartAt = Date.now() + options.intervalMs;
    let released = false;
    request.resolve(() => {
      if (released) return;
      released = true;
      inFlight -= 1;
      pump();
    });
    pump();
  };

  /**
   * `priority` 越大越先拿到名额（同优先级保持 FIFO）。
   *
   * 广告 today 实时同步已下线；当前广告历史同步统一使用普通优先级。
   */
  return {
    acquire: (priority = 0, signal?: AbortSignal) => new Promise<ReleaseRequestSlot>((resolve, reject) => {
      let settled = false;
      const request: PendingRequest = {
        priority,
        cancelled: false,
        resolve: (release) => {
          if (settled) {
            release();
            return;
          }
          settled = true;
          signal?.removeEventListener('abort', abortHandler);
          resolve(release);
        },
        reject: (reason) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', abortHandler);
          reject(reason);
        },
      };
      const abortHandler = (): void => {
        if (settled) return;
        request.cancelled = true;
        const index = pending.indexOf(request);
        if (index >= 0) pending.splice(index, 1);
        request.reject(createAbortError());
        pump();
      };
      if (signal?.aborted) {
        abortHandler();
        return;
      }
      signal?.addEventListener('abort', abortHandler, { once: true });
      // 插到第一个优先级更低的元素之前 → 高优先级先出、同级维持 FIFO。
      const at = pending.findIndex((candidate) => candidate.priority < priority);
      if (at === -1) pending.push(request);
      else pending.splice(at, 0, request);
      pump();
    }),
  };
}
