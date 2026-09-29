import type { OrderDomainKey, OrderSyncTrigger } from '../core/types';

export interface OrderRunLockSnapshot {
  manualStartPending: boolean;
  ordersInFlight: boolean;
  domainsInFlight: Exclude<OrderDomainKey, 'orders'>[];
}

export type OrderRunDeferralReason = 'manual_operation_active' | 'order_domain_busy';

export type OrderRunResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'deferred'; reason: OrderRunDeferralReason }
  | { status: 'skipped'; reason: 'in_flight' };

export interface OrderRunRequest<T> {
  domain: OrderDomainKey;
  trigger: OrderSyncTrigger;
  work: () => Promise<T>;
  onDeferred?: (reason: OrderRunDeferralReason) => Promise<void>;
}

/**
 * Owns process-local admission for Order Domain Sync Runs.
 * Durable recovery stays in the state store because MV3 worker restarts clear this module's memory.
 */
export class OrderRunCoordinator {
  readonly #activeDomains = new Set<OrderDomainKey>();
  readonly #stoppedRunIds = new Set<string>();
  #manualStartPending = false;

  snapshot(): OrderRunLockSnapshot {
    return {
      manualStartPending: this.#manualStartPending,
      ordersInFlight: this.#activeDomains.has('orders'),
      domainsInFlight: [...this.#activeDomains]
        .filter((domain): domain is Exclude<OrderDomainKey, 'orders'> => domain !== 'orders'),
    };
  }

  isActive(domain: OrderDomainKey): boolean {
    return this.#activeDomains.has(domain);
  }

  async run<T>(request: OrderRunRequest<T>): Promise<OrderRunResult<T>> {
    const automaticDeferral = this.#automaticDeferralReason(request.trigger);
    if (automaticDeferral) {
      await request.onDeferred?.(automaticDeferral);
      return { status: 'deferred', reason: automaticDeferral };
    }
    if (this.#conflictsWithActiveRun(request.domain)) {
      return { status: 'skipped', reason: 'in_flight' };
    }

    const release = this.reserve(request.domain);
    try {
      return { status: 'completed', value: await request.work() };
    } finally {
      release();
    }
  }

  reserve(domain: OrderDomainKey): () => void {
    this.#activeDomains.add(domain);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeDomains.delete(domain);
    };
  }

  beginManual(options: { requireIdle: boolean }): (() => void) | null {
    if (this.#manualStartPending || (options.requireIdle && this.#activeDomains.size > 0)) return null;
    this.#manualStartPending = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#manualStartPending = false;
    };
  }

  stopRun(runId: string | null | undefined): void {
    if (runId) this.#stoppedRunIds.add(runId);
  }

  isRunCurrent(runId: string | null | undefined): boolean {
    return !runId || !this.#stoppedRunIds.has(runId);
  }

  async waitForIdle(timeoutMs: number, pollIntervalMs = 250): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.#activeDomains.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return this.#activeDomains.size === 0;
  }

  #automaticDeferralReason(trigger: OrderSyncTrigger): OrderRunDeferralReason | null {
    if (trigger !== 'automatic') return null;
    if (this.#manualStartPending) return 'manual_operation_active';
    return this.#activeDomains.size > 0 ? 'order_domain_busy' : null;
  }

  #conflictsWithActiveRun(domain: OrderDomainKey): boolean {
    if (this.#activeDomains.has(domain)) return true;
    if (domain === 'orders') return this.#activeDomains.size > 0;
    return this.#activeDomains.has('orders');
  }
}
