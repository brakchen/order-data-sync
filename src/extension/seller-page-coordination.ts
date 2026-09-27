export const SELLER_PAGE_COORDINATION_KEY = '__ttsSellerCenterCoordinationV1';
export const SELLER_PAGE_REQUEST_LEASE_MS = 2 * 60_000;
export const SELLER_PAGE_REFRESH_CLAIM_MS = 30_000;
export const SELLER_PAGE_REFRESH_QUIET_MS = 15_000;

interface SellerPageCoordinationState {
  activeRequests: Record<string, number>;
  lastActivityAt: number;
  refreshClaimUntil: number;
}

export interface SellerPageRefreshDecision {
  allowed: boolean;
  reason: 'allowed' | 'active_requests' | 'recent_activity' | 'refresh_claimed'
    | 'page_recently_loaded' | 'coordination_unavailable';
  pageAgeMs: number;
  retryAfterMs: number;
  activeRequestCount: number;
}

/** Atomically checks shared page activity and claims the next reload task. */
export function claimSellerPageRefresh(
  storageKey: string,
  minimumPageAgeMs: number,
  claimMs: number,
  quietMs: number,
): SellerPageRefreshDecision {
  const unavailable = (): SellerPageRefreshDecision => ({
    allowed: false,
    reason: 'coordination_unavailable',
    pageAgeMs: 0,
    retryAfterMs: 60_000,
    activeRequestCount: 0,
  });
  try {
    const now = Date.now();
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as Partial<SellerPageCoordinationState>;
    const activeRequests = typeof parsed.activeRequests === 'object' && parsed.activeRequests !== null
      ? parsed.activeRequests : {};
    const liveRequests = Object.fromEntries(Object.entries(activeRequests)
      .filter(([, expiresAt]) => typeof expiresAt === 'number' && expiresAt > now));
    const lastActivityAt = typeof parsed.lastActivityAt === 'number' ? parsed.lastActivityAt : 0;
    const refreshClaimUntil = typeof parsed.refreshClaimUntil === 'number' ? parsed.refreshClaimUntil : 0;
    const pageAgeMs = Math.max(0, now - performance.timeOrigin);
    const persist = (nextRefreshClaimUntil = refreshClaimUntil) => window.localStorage.setItem(storageKey, JSON.stringify({
      activeRequests: liveRequests,
      lastActivityAt,
      refreshClaimUntil: nextRefreshClaimUntil,
    } satisfies SellerPageCoordinationState));
    const activeRequestCount = Object.keys(liveRequests).length;
    if (activeRequestCount > 0) {
      const latestLease = Math.max(...Object.values(liveRequests));
      persist();
      return { allowed: false, reason: 'active_requests', pageAgeMs,
        retryAfterMs: Math.max(1_000, latestLease - now), activeRequestCount };
    }
    if (lastActivityAt > 0 && now - lastActivityAt < quietMs) {
      persist();
      return { allowed: false, reason: 'recent_activity', pageAgeMs,
        retryAfterMs: quietMs - (now - lastActivityAt), activeRequestCount: 0 };
    }
    if (refreshClaimUntil > now) {
      persist();
      return { allowed: false, reason: 'refresh_claimed', pageAgeMs,
        retryAfterMs: refreshClaimUntil - now, activeRequestCount: 0 };
    }
    if (pageAgeMs < minimumPageAgeMs) {
      persist();
      return { allowed: false, reason: 'page_recently_loaded', pageAgeMs,
        retryAfterMs: minimumPageAgeMs - pageAgeMs, activeRequestCount: 0 };
    }
    persist(now + claimMs);
    return { allowed: true, reason: 'allowed', pageAgeMs,
      retryAfterMs: minimumPageAgeMs, activeRequestCount: 0 };
  } catch {
    return unavailable();
  }
}
