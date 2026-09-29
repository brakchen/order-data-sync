import { describe, expect, it, vi } from 'vitest';
import type { OrderSyncSettings, OrderSyncState } from '../src/core/types';
import { createDefaultOrderSyncState } from '../src/extension/storage';
import { createPopupApplicationState } from '../src/extension/popup-application-state';

function stateWithToken(token: string): OrderSyncState {
  const state = createDefaultOrderSyncState();
  return { ...state, settings: { ...state.settings, syncToken: token } };
}

function harness(initial = stateWithToken('server-token')) {
  let state = structuredClone(initial);
  let scheduled: (() => void) | null = null;
  const saveSettings = vi.fn(async (settings: OrderSyncSettings) => {
    state = { ...state, settings };
    return structuredClone(state);
  });
  const app = createPopupApplicationState({
    loadState: vi.fn(async () => structuredClone(state)),
    saveSettings,
    syncDomains: vi.fn(async () => structuredClone(state)),
    stopStuckDomain: vi.fn(async () => structuredClone(state)),
    schedule: (task) => { scheduled = task; return 1; },
    cancel: () => { scheduled = null; },
  });
  return { app, saveSettings, runScheduled: () => scheduled?.() };
}

describe('Popup application state', () => {
  it('does not overwrite a touched draft when initialization resolves late', async () => {
    let resolveLoad!: (state: OrderSyncState) => void;
    const app = createPopupApplicationState({
      loadState: () => new Promise((resolve) => { resolveLoad = resolve; }),
      saveSettings: vi.fn(),
      syncDomains: vi.fn(),
      stopStuckDomain: vi.fn(),
      schedule: () => 1,
      cancel: () => undefined,
    });
    const initializing = app.initialize();
    app.updateDraft({ ...app.getSnapshot().draft, syncToken: 'typed-token' });

    resolveLoad(stateWithToken('server-token'));
    await initializing;

    expect(app.getSnapshot().state?.settings.syncToken).toBe('server-token');
    expect(app.getSnapshot().draft.syncToken).toBe('typed-token');
  });

  it('debounces draft persistence behind the application-state interface', async () => {
    const { app, saveSettings, runScheduled } = harness();
    await app.initialize();

    app.updateDraft({ ...app.getSnapshot().draft, syncToken: 'next-token' });
    expect(saveSettings).not.toHaveBeenCalled();

    runScheduled();
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce());
    expect(app.getSnapshot()).toMatchObject({ busy: false, notice: '配置已自动保存。' });
  });

  it('publishes busy state around a Sync Run command', async () => {
    const { app } = harness();
    await app.initialize();
    const snapshots: boolean[] = [];
    const unsubscribe = app.subscribe(() => snapshots.push(app.getSnapshot().busy));

    await app.syncDomains(false);

    expect(snapshots).toContain(true);
    expect(app.getSnapshot()).toMatchObject({ busy: false, notice: '订单域各接口同步已启动。' });
    unsubscribe();
  });
});
