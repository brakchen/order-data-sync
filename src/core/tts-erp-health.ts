/**
 * tts-erp /healthz 探活模块。
 *
 * 设计策略：3 秒轮询 + 同步前门控
 * - 每 3 秒 GET /healthz（chrome.alarms 最小 30s，改用 setInterval）
 * - 结果缓存在模块级状态，同步循环开始前读取
 * - 不健康 → 跳过本轮同步，等待探活恢复
 * - 连续 2 次失败才标记 unhealthy（容忍瞬时抖动）
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface TtsErpHealthState {
  /** tts-erp 是否可达（最后一次 /healthz 返回 2xx） */
  healthy: boolean;
  /** 上次检查时间（epoch ms） */
  lastCheckedAt: number;
  /** 最后一次失败原因（仅 unhealthy 时有值） */
  lastError?: string;
  /** 连续失败次数（healthy 时归零） */
  consecutiveFailures: number;
}

// ─── Constants ─────────────────────────────────────────────────────

/** 探活间隔：3 秒 */
export const HEALTH_CHECK_INTERVAL_MS = 3_000;
/** 单次 /healthz 请求超时：5 秒 */
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;
/** 连续失败多少次后标记为 unhealthy（容忍瞬时抖动） */
export const HEALTH_FAILURE_THRESHOLD = 2;

// ─── Module state ──────────────────────────────────────────────────

let healthState: TtsErpHealthState = {
  healthy: true,
  lastCheckedAt: 0,
  consecutiveFailures: 0,
};

let checkInFlight = false;
let pollingTimer: ReturnType<typeof setInterval> | null = null;

// ─── Public API ────────────────────────────────────────────────────

/**
 * 执行一次 /healthz 探活。并发安全（同时只跑一个请求）。
 * 返回 true = tts-erp 可达。
 */
export async function checkTtsErpHealth(
  baseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  if (checkInFlight) return healthState.healthy;
  checkInFlight = true;
  try {
    const normalisedBase = baseUrl.trim().replace(/\/+$/, '');
    if (!normalisedBase) {
      updateHealth(false, 'syncBaseUrl 未配置');
      return false;
    }
    const url = `${normalisedBase}/healthz`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        updateHealth(true);
        return true;
      }
      updateHealth(false, `HTTP ${response.status}`);
      return false;
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error
        ? (error.name === 'AbortError' ? '请求超时' : error.message.slice(0, 120))
        : '网络异常';
      updateHealth(false, message);
      return false;
    }
  } finally {
    checkInFlight = false;
  }
}

/**
 * 读取缓存的健康状态。不做网络请求。
 * 同步循环开始前调用此函数做门控。
 */
export function isTtsErpHealthy(): boolean {
  return healthState.healthy;
}

/**
 * 获取完整的健康状态快照（供 UI / runtime log 展示）。
 */
export function getTtsErpHealthState(): Readonly<TtsErpHealthState> {
  return { ...healthState };
}

/**
 * 是否需要执行下一次探活（距上次检查已超 interval）。
 */
export function isHealthCheckDue(): boolean {
  return Date.now() - healthState.lastCheckedAt >= HEALTH_CHECK_INTERVAL_MS;
}

/**
 * 重置健康状态为初始值（配置变更时调用）。
 */
export function resetHealthState(): void {
  healthState = {
    healthy: true,
    lastCheckedAt: 0,
    consecutiveFailures: 0,
  };
}

/**
 * 启动 3 秒轮询。重复调用安全（不会创建多个 timer）。
 * @param getBaseUrl 获取当前 syncBaseUrl 的函数（避免循环依赖）
 * @param onStateChange 状态变化时的回调（可选，用于记 runtime log）
 */
export function startHealthPolling(
  getBaseUrl: () => string | undefined | Promise<string | undefined>,
  onStateChange?: (healthy: boolean, state: TtsErpHealthState) => void,
): void {
  if (pollingTimer !== null) return;
  const wasHealthy = () => healthState.healthy;
  pollingTimer = setInterval(() => {
    void (async () => {
      const baseUrl = await getBaseUrl();
      if (!baseUrl) return;
      const beforeHealthy = wasHealthy();
      const nowHealthy = await checkTtsErpHealth(baseUrl);
      if (beforeHealthy !== nowHealthy && onStateChange) {
        onStateChange(nowHealthy, getTtsErpHealthState());
      }
    })();
  }, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * 停止轮询。解绑 / 插件卸载时调用。
 */
export function stopHealthPolling(): void {
  if (pollingTimer !== null) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

// ─── Internal ──────────────────────────────────────────────────────

function updateHealth(healthy: boolean, error?: string): void {
  if (healthy) {
    healthState = {
      healthy: true,
      lastCheckedAt: Date.now(),
      consecutiveFailures: 0,
    };
  } else {
    const consecutiveFailures = healthState.consecutiveFailures + 1;
    healthState = {
      healthy: consecutiveFailures < HEALTH_FAILURE_THRESHOLD,
      lastCheckedAt: Date.now(),
      lastError: error,
      consecutiveFailures,
    };
  }
}
