import { describe, expect, it, vi } from 'vitest';
import { OrderRunCoordinator } from '../src/extension/order-run-coordinator';

describe('OrderRunCoordinator', () => {
  it('defers an automatic Sync Run while another Order Domain is active', async () => {
    const coordinator = new OrderRunCoordinator();
    const release = coordinator.reserve('logistics');
    const onDeferred = vi.fn(async () => undefined);
    const work = vi.fn(async () => 'done');

    const result = await coordinator.run({
      domain: 'orders',
      trigger: 'automatic',
      onDeferred,
      work,
    });

    expect(result).toEqual({ status: 'deferred', reason: 'order_domain_busy' });
    expect(onDeferred).toHaveBeenCalledWith('order_domain_busy');
    expect(work).not.toHaveBeenCalled();
    release();
  });

  it('holds and releases one domain around a completed Sync Run', async () => {
    const coordinator = new OrderRunCoordinator();
    let snapshotDuringRun = coordinator.snapshot();

    const result = await coordinator.run({
      domain: 'orders',
      trigger: 'manual',
      work: async () => {
        snapshotDuringRun = coordinator.snapshot();
        return 42;
      },
    });

    expect(result).toEqual({ status: 'completed', value: 42 });
    expect(snapshotDuringRun).toEqual({
      manualStartPending: false,
      ordersInFlight: true,
      domainsInFlight: [],
    });
    expect(coordinator.snapshot().ordersInFlight).toBe(false);
  });

  it('keeps the manual reservation until its caller releases it', () => {
    const coordinator = new OrderRunCoordinator();
    const release = coordinator.beginManual({ requireIdle: true });

    expect(release).toBeTypeOf('function');
    expect(coordinator.beginManual({ requireIdle: true })).toBeNull();
    expect(coordinator.snapshot().manualStartPending).toBe(true);

    release?.();
    expect(coordinator.snapshot().manualStartPending).toBe(false);
  });

  it('marks a replaced durable run as stopped', () => {
    const coordinator = new OrderRunCoordinator();

    coordinator.stopRun('old-run');

    expect(coordinator.isRunCurrent('old-run')).toBe(false);
    expect(coordinator.isRunCurrent('new-run')).toBe(true);
    expect(coordinator.isRunCurrent(null)).toBe(true);
  });
});
