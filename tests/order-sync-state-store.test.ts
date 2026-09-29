import { describe, expect, it } from 'vitest';
import type { OrderSyncState } from '../src/core/types';
import {
  createDefaultOrderSyncState,
  createOrderSyncStateStore,
  type OrderSyncStateStorageAdapter,
} from '../src/extension/storage';

function memoryAdapter(initial = createDefaultOrderSyncState()): {
  adapter: OrderSyncStateStorageAdapter;
  current: () => OrderSyncState;
} {
  let state = structuredClone(initial);
  return {
    adapter: {
      load: async () => structuredClone(state),
      save: async (next) => { state = structuredClone(next); },
    },
    current: () => structuredClone(state),
  };
}

describe('Order sync state store', () => {
  it('serializes atomic updates through one interface', async () => {
    const memory = memoryAdapter();
    const store = createOrderSyncStateStore(memory.adapter);
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = store.update(async (state) => {
      await firstMayFinish;
      return { ...state, settings: { ...state.settings, syncPaused: true } };
    });
    const second = store.update((state) => ({
      ...state,
      sellerBinding: { ...state.sellerBinding, mode: 'auto' },
    }));

    releaseFirst();
    await Promise.all([first, second]);

    expect(memory.current().settings.syncPaused).toBe(true);
    expect(memory.current().sellerBinding.mode).toBe('auto');
  });

  it('continues processing after a rejected update', async () => {
    const memory = memoryAdapter();
    const store = createOrderSyncStateStore(memory.adapter);

    await expect(store.update(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await store.update((state) => ({ ...state, settings: { ...state.settings, syncPaused: true } }));

    await expect(store.read()).resolves.toMatchObject({ settings: { syncPaused: true } });
  });
});
