import { createDefaultOrderSettings } from '../core/settings';
import type { OrderDomainKey, OrderSyncSettings, OrderSyncState } from '../core/types';

export interface PopupApplicationSnapshot {
  state: OrderSyncState | null;
  draft: OrderSyncSettings;
  busy: boolean;
  notice: string;
}

export interface PopupApplicationDependencies {
  loadState(): Promise<OrderSyncState>;
  saveSettings(settings: OrderSyncSettings): Promise<OrderSyncState>;
  resetEndpointCircuit(): Promise<OrderSyncState>;
  syncDomains(retryFailedOnly: boolean): Promise<OrderSyncState>;
  stopStuckDomain(domain: OrderDomainKey): Promise<OrderSyncState>;
  schedule(task: () => void, delayMs: number): number;
  cancel(handle: number): void;
}

export interface PopupLogExport {
  contents: string;
  fileName: string;
  count: number;
}

export class PopupApplicationState {
  readonly #listeners = new Set<() => void>();
  #snapshot: PopupApplicationSnapshot = {
    state: null,
    draft: createDefaultOrderSettings(),
    busy: false,
    notice: '',
  };
  #settingsInitialized = false;
  #lastSavedSettings = '';
  #draftTouched = false;
  #autosaveHandle: number | null = null;

  constructor(private readonly dependencies: PopupApplicationDependencies) {}

  getSnapshot = (): PopupApplicationSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async initialize(): Promise<void> {
    await this.refresh(true);
  }

  async refresh(updateDraft = false): Promise<void> {
    try {
      const state = await this.dependencies.loadState();
      this.#replace({ state });
      if (!updateDraft) return;
      this.#settingsInitialized = true;
      this.#lastSavedSettings = serializeSettings(state.settings);
      if (this.#draftTouched) this.#scheduleAutosave();
      else this.#replace({ draft: state.settings });
    } catch (error) {
      this.#replace({ notice: toMessage(error) });
    }
  }

  updateDraft(settings: OrderSyncSettings): void {
    this.#draftTouched = true;
    this.#replace({ draft: settings });
    this.#scheduleAutosave();
  }

  async saveSettingsNow(success = '配置已自动保存。'): Promise<void> {
    this.#cancelAutosave();
    const settings = this.#snapshot.draft;
    await this.#run(
      () => this.dependencies.saveSettings(settings),
      success,
      true,
    );
  }

  async syncDomains(retryFailedOnly: boolean): Promise<void> {
    await this.#run(
      () => this.dependencies.syncDomains(retryFailedOnly),
      retryFailedOnly ? '失败项已加入同步队列。' : '订单域各接口同步已启动。',
      false,
    );
  }

  async resetEndpointCircuit(): Promise<void> {
    await this.#run(
      () => this.dependencies.resetEndpointCircuit(),
      '已解除接口熔断，可以重新同步。',
      true,
    );
  }

  async stopStuckDomain(domain: OrderDomainKey, label: string): Promise<void> {
    await this.#run(
      () => this.dependencies.stopStuckDomain(domain),
      `${label}任务已停止并从断点重试。`,
      false,
    );
  }

  exportLogs(extensionVersion: string, exportedAt = new Date()): PopupLogExport | null {
    const state = this.#snapshot.state;
    if (!state) return null;
    const contents = JSON.stringify({
      schemaVersion: 1,
      exportedAt: exportedAt.toISOString(),
      extensionVersion,
      boundTab: state.boundTab,
      orderProgress: state.orderProgress,
      runtimeLogs: state.runtimeLogs,
    }, null, 2);
    this.#replace({ notice: `已导出 ${state.runtimeLogs.length} 条运行日志。` });
    return {
      contents,
      fileName: `order-data-sync-logs-${formatFileTimestamp(exportedAt)}.json`,
      count: state.runtimeLogs.length,
    };
  }

  async #run(
    action: () => Promise<OrderSyncState>,
    success: string,
    updateDraft: boolean,
  ): Promise<void> {
    this.#replace({ busy: true, notice: '' });
    try {
      const state = await action();
      this.#replace({ state });
      if (updateDraft) {
        this.#settingsInitialized = true;
        this.#lastSavedSettings = serializeSettings(state.settings);
        this.#draftTouched = false;
        this.#replace({ draft: state.settings });
      }
      this.#replace({ notice: success });
    } catch (error) {
      this.#replace({ notice: toMessage(error) });
    } finally {
      this.#replace({ busy: false });
    }
  }

  #scheduleAutosave(): void {
    if (!this.#settingsInitialized
      || serializeSettings(this.#snapshot.draft) === this.#lastSavedSettings) return;
    this.#cancelAutosave();
    this.#autosaveHandle = this.dependencies.schedule(() => {
      this.#autosaveHandle = null;
      void this.saveSettingsNow();
    }, 600);
  }

  #cancelAutosave(): void {
    if (this.#autosaveHandle === null) return;
    this.dependencies.cancel(this.#autosaveHandle);
    this.#autosaveHandle = null;
  }

  #replace(patch: Partial<PopupApplicationSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#listeners.forEach((listener) => listener());
  }
}

export function createPopupApplicationState(
  dependencies: PopupApplicationDependencies,
): PopupApplicationState {
  return new PopupApplicationState(dependencies);
}

function serializeSettings(value: OrderSyncSettings): string {
  return JSON.stringify({
    syncBaseUrl: value.syncBaseUrl,
    syncToken: value.syncToken,
    syncPaused: value.syncPaused,
    orderDomainSyncEnabled: value.orderDomainSyncEnabled,
  });
}

function formatFileTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-');
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
