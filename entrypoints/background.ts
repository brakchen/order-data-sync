import { defineBackground } from 'wxt/utils/define-background';
import { normalizeOrderSyncBaseUrl, normalizeOrderSyncSettings } from '../src/core/settings';
import type { OrderExtensionMessage } from '../src/extension/messages';
import { createDefaultOrderProgress, getOrderSyncState, mutateOrderSyncState } from '../src/extension/storage';
import type { OrderDomainKey, OrderSyncState } from '../src/core/types';
import {
  claimSellerPageRefresh,
  SELLER_PAGE_COORDINATION_KEY,
  SELLER_PAGE_REFRESH_CLAIM_MS,
  SELLER_PAGE_REFRESH_QUIET_MS,
  type SellerPageRefreshDecision,
} from '../src/extension/seller-page-coordination';
import {
  ensureBoundDomainAlarms,
  getOrderSyncLockSnapshot,
  handleOrderSyncAlarm,
  ORDER_SYNC_ALARMS,
  pollOrderDomain,
  probeSellerIdentityInBoundPage,
  recordOrderSyncRuntimeLog,
  reportSchedulerError,
  requestManualOrderDomainSync,
  resetTikTokEndpointCircuit,
  runInitialOrderDomainSync,
  SELLER_TAB_ALARMS,
  SELLER_TAB_WATCH_DELAY_MINUTES,
  stopStuckOrderDomainAndRetry,
} from '../src/extension/order-engine';

const SELLER_TAB_REFRESH_DELAY_MINUTES = 120;
const SELLER_TAB_REFRESH_RETRY_MINUTES = 5;
const SELLER_TAB_REFRESH_MINIMUM_AGE_MS = SELLER_TAB_REFRESH_DELAY_MINUTES * 60_000;
const AUTO_BIND_TIMEOUT_MS = 10_000;
const AUTO_BIND_POLL_INTERVAL_MS = 250;
let autoBindingRunId = 0;
let autoBindingPromise: Promise<void> | null = null;

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: OrderExtensionMessage, sender, sendResponse) => {
    void handleOrderMessage(message, sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error: unknown) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : '订单插件请求失败。',
      }));
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void handleBoundTabRemoved(tabId).catch((error) => reportError(error, 'tab_removed'));
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.pinned !== undefined) {
      void handleBoundTabPinChanged(tabId, changeInfo.pinned)
        .catch((error) => reportError(error, 'bound_tab_pin_changed'));
    }
    if (changeInfo.url) {
      void handleBoundTabNavigation(tabId, changeInfo.url)
        .catch((error) => reportError(error, 'bound_tab_navigation'));
    }
  });

  void initializeBackground().catch((error) => reportError(error, 'extension_startup'));
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ORDER_SYNC_ALARMS.orders || alarm.name === ORDER_SYNC_ALARMS.ordersContinue) {
      void handleOrderSyncAlarm().catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    } else if (alarm.name === ORDER_SYNC_ALARMS.logistics || alarm.name === ORDER_SYNC_ALARMS.logisticsContinue) {
      void pollOrderDomain('logistics').catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    } else if (alarm.name === ORDER_SYNC_ALARMS.statements || alarm.name === ORDER_SYNC_ALARMS.statementsContinue) {
      void pollOrderDomain('statements').catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    } else if (alarm.name === ORDER_SYNC_ALARMS.order_details || alarm.name === ORDER_SYNC_ALARMS.orderDetailsContinue) {
      void pollOrderDomain('order_details').catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    } else if (alarm.name === ORDER_SYNC_ALARMS.order_history || alarm.name === ORDER_SYNC_ALARMS.orderHistoryContinue) {
      void pollOrderDomain('order_history').catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    } else if (alarm.name === SELLER_TAB_ALARMS.refresh) {
      void refreshBoundSellerTab().catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    } else if (alarm.name === SELLER_TAB_ALARMS.watch) {
      void scanForReplacementSellerTab().catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    }
  });
});

async function initializeBackground(): Promise<void> {
  await recoverSellerBindingOnStartup();
  await ensureBoundAlarms('extension_startup');
}

async function recoverSellerBindingOnStartup(): Promise<void> {
  const current = await getOrderSyncState();
  if (current.sellerBinding.mode === 'auto') {
    const deadlineAt = Date.parse(current.sellerBinding.deadlineAt ?? '');
    if (current.settings.syncToken.trim() && Number.isFinite(deadlineAt) && deadlineAt > Date.now()) {
      await recordOrderSyncRuntimeLog('all', 'seller_auto_bind_resumed', 'recorded', '后台重新启动，已恢复未完成的自动绑定流程。', {
        stage: 'seller_binding',
        deadlineAt: new Date(deadlineAt).toISOString(),
        remainingMs: Math.max(0, deadlineAt - Date.now()),
        preservedBoundTab: Boolean(current.boundTab),
      });
      void startAutomaticSellerBinding(deadlineAt).catch((error) => reportError(error, 'auto_bind_resume'));
      return;
    }
    const hasSellerId = Boolean(current.boundTab?.sellerId);
    await mutateOrderSyncState((state) => state.sellerBinding.mode === 'auto'
      ? {
        ...state,
        boundTab: hasSellerId ? state.boundTab : null,
        sellerBinding: {
          mode: 'idle',
          outcome: hasSellerId ? 'bound' : 'timeout',
          deadlineAt: null,
        },
      }
      : state);
    await recordOrderSyncRuntimeLog('all', 'seller_binding_recovered', 'recorded', '后台重新启动，已释放遗留的自动绑定状态。', {
      stage: 'seller_binding',
      previousMode: 'auto',
      reason: current.settings.syncToken.trim() ? 'deadline_expired' : 'token_missing',
      preservedSellerId: hasSellerId,
    });
    return;
  }

  if (current.sellerBinding.mode === 'manual') {
    const hasSellerId = Boolean(current.boundTab?.sellerId);
    await mutateOrderSyncState((state) => state.sellerBinding.mode === 'manual'
      ? {
        ...state,
        sellerBinding: {
          mode: 'idle',
          outcome: hasSellerId ? 'bound' : 'none',
          deadlineAt: null,
        },
      }
      : state);
    await recordOrderSyncRuntimeLog('all', 'seller_binding_recovered', 'recorded', '后台重新启动，已释放遗留的手动绑定状态。', {
      stage: 'seller_binding',
      previousMode: 'manual',
      preservedSellerId: hasSellerId,
    });
  }
}

export async function handleOrderMessage(
  message: OrderExtensionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message.type) {
    case 'order-sync:get-state':
      return getOrderSyncState();
    case 'order-sync:save-settings': {
      const settings = normalizeOrderSyncSettings(message.settings);
      if (settings.syncBaseUrl && !isHttpUrl(settings.syncBaseUrl)) throw new Error('同步地址必须是有效的 HTTP(S) URL。');
      let shouldStartAutoBinding = false;
      let circuitResetRequested = false;
      const next = await mutateOrderSyncState((current) => {
        circuitResetRequested = current.settings.syncPaused && !settings.syncPaused;
        const destinationChanged = normalizeOrderSyncBaseUrl(current.settings.syncBaseUrl)
          !== normalizeOrderSyncBaseUrl(settings.syncBaseUrl)
          || current.settings.syncToken.trim() !== settings.syncToken.trim();
        const tokenBecameConfigured = !current.settings.syncToken.trim() && settings.syncToken.trim().length > 0;
        shouldStartAutoBinding = tokenBecameConfigured
          && !current.boundTab
          && current.sellerBinding.mode === 'idle';
        const autoBindingCancelled = !settings.syncToken.trim() && current.sellerBinding.mode === 'auto';
        if (autoBindingCancelled) autoBindingRunId += 1;
        return {
          ...current,
          settings,
          ...(circuitResetRequested ? { endpointCircuit: null } : {}),
          ...(autoBindingCancelled ? {
            sellerBinding: { mode: 'idle' as const, outcome: 'none' as const, deadlineAt: null },
          } : {}),
          ...(destinationChanged ? {
            shopRegion: null,
            orderProgress: createDefaultOrderProgress(),
          } : {}),
        };
      });
      if (circuitResetRequested) resetTikTokEndpointCircuit();
      await ensureBoundAlarms('configuration_ready');
      if (shouldStartAutoBinding) void startAutomaticSellerBinding().catch((error) => reportError(error, 'auto_bind'));
      return next;
    }
    case 'order-sync:bind-tab':
      return bindCurrentSellerTab();
    case 'order-sync:unbind-tab':
      return unbindCurrentSellerTab();
    case 'order-sync:sync-domains':
      await requestManualOrderDomainSync(message.retryFailedOnly === true);
      return getOrderSyncState();
    case 'order-sync:stop-stuck-domain':
      await stopStuckOrderDomainAndRetry(message.domain);
      return getOrderSyncState();
    case 'order-sync:capture-seller':
      return captureSellerIdentity(message.payload, sender);
  }
}

async function bindCurrentSellerTab(): Promise<OrderSyncState> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !isSellerCenterUrl(tab.url)) throw new Error('请先打开 TikTok Shop Seller Center 页面。');
  const existing = await getOrderSyncState();
  if (existing.sellerBinding.mode !== 'idle') {
    throw new Error(existing.sellerBinding.mode === 'auto' ? '自动绑定正在进行，请等待自动绑定结束或超时。' : '手动绑定正在进行，请稍候。');
  }
  await mutateOrderSyncState((current) => {
    if (current.sellerBinding.mode !== 'idle') {
      throw new Error(current.sellerBinding.mode === 'auto' ? '自动绑定正在进行，请等待自动绑定结束或超时。' : '手动绑定正在进行，请稍候。');
    }
    return {
      ...current,
      sellerBinding: { mode: 'manual', outcome: 'none', deadlineAt: null },
      boundTab: {
        tabId: tab.id!,
        url: tab.url!,
        ...(current.boundTab?.sellerId ? { sellerId: current.boundTab.sellerId } : {}),
        ...(current.boundTab?.advertiserId ? { advertiserId: current.boundTab.advertiserId } : {}),
        ...(current.boundTab?.shopName ? { shopName: current.boundTab.shopName } : {}),
        ...(current.boundTab?.shopCode ? { shopCode: current.boundTab.shopCode } : {}),
        ...(current.boundTab?.shopRegion ? { shopRegion: current.boundTab.shopRegion } : {}),
        ...(current.boundTab?.sellerRegionCode ? { sellerRegionCode: current.boundTab.sellerRegionCode } : {}),
        bindMode: 'manual',
        boundAt: new Date().toISOString(),
      },
    };
  });
  try {
    await pinSellerTab(tab.id, 'manual_bind');
    await recordOrderSyncRuntimeLog('all', 'seller_bind_requested', 'started', '已绑定当前 Seller Center 页面，准备主动读取 Seller ID。', {
      stage: 'seller_binding',
      tabId: tab.id,
      pageOrigin: new URL(tab.url!).origin,
      pagePath: new URL(tab.url!).pathname,
      reloadRequested: false,
    });
    await probeAndCaptureSellerIdentity(tab);
    await ensureBoundAlarms();
  } finally {
    await mutateOrderSyncState((current) => current.sellerBinding.mode === 'manual'
      ? {
        ...current,
        sellerBinding: {
          mode: 'idle',
          outcome: current.boundTab?.sellerId ? 'bound' : 'none',
          deadlineAt: null,
        },
      }
      : current);
  }
  return getOrderSyncState();
}

async function unbindCurrentSellerTab(): Promise<OrderSyncState> {
  autoBindingRunId += 1;
  const next = await mutateOrderSyncState((state) => ({
    ...state,
    boundTab: null,
    sellerBinding: { mode: 'idle', outcome: 'none', deadlineAt: null },
    shopRegion: null,
  }));
  await clearOrderAlarms();
  return next;
}

async function captureSellerIdentity(
  payload: {
    sellerId: string;
    url: string;
    advertiserId?: string;
    shopName?: string;
    shopCode?: string;
    shopRegion?: string;
    regionCode?: string;
  },
  sender: chrome.runtime.MessageSender,
): Promise<OrderSyncState> {
  const senderTabId = sender.tab?.id;
  const current = await getOrderSyncState();
  if (senderTabId === undefined || !isSellerCenterUrl(payload.url) || !payload.sellerId.trim()) {
    await recordOrderSyncRuntimeLog('all', 'seller_identity_ignored', 'skipped', '忽略无效的 Seller ID 捕获消息。', {
      stage: 'seller_binding',
      reason: senderTabId === undefined ? 'sender_tab_missing'
        : !isSellerCenterUrl(payload.url) ? 'page_origin_not_allowed' : 'seller_id_empty',
      senderTabId: senderTabId ?? null,
    });
    return current;
  }
  let sameSellerCenterOrigin = false;
  try {
    sameSellerCenterOrigin = Boolean(current.boundTab)
      && new URL(current.boundTab!.url).origin === new URL(payload.url).origin;
  } catch {
    sameSellerCenterOrigin = false;
  }
  if (current.boundTab?.tabId !== senderTabId && !sameSellerCenterOrigin) {
    await recordOrderSyncRuntimeLog('all', 'seller_identity_ignored', 'skipped', '忽略非当前绑定页面的 Seller ID 捕获消息。', {
      stage: 'seller_binding',
      reason: 'sender_tab_not_bound',
      senderTabId,
      boundTabId: current.boundTab?.tabId ?? null,
      sameSellerCenterOrigin: false,
    });
    return current;
  }
  const capturedFromBoundTab = current.boundTab?.tabId === senderTabId;
  const next = await mutateOrderSyncState((current) => {
    const boundTab = current.boundTab;
    if (!boundTab || (boundTab.tabId !== senderTabId && !sameSellerCenterOrigin)) return current;
    const sellerId = payload.sellerId.trim();
    return {
      ...current,
      sellerBinding: { mode: 'idle', outcome: 'bound', deadlineAt: null },
      boundTab: {
        ...boundTab,
        ...(capturedFromBoundTab ? { url: payload.url } : {}),
        sellerId,
        ...(payload.advertiserId ? { advertiserId: payload.advertiserId } : {}),
        ...(payload.shopName ? { shopName: payload.shopName } : {}),
        ...(payload.shopCode ? { shopCode: payload.shopCode } : {}),
        ...(payload.shopRegion ? { shopRegion: payload.shopRegion } : {}),
        ...(payload.regionCode ? { sellerRegionCode: payload.regionCode } : {}),
      },
    };
  });
  await recordOrderSyncRuntimeLog('all', 'seller_identity_captured', 'succeeded', '已从 Seller Center 页面请求捕获 Seller ID。', {
    stage: 'seller_binding',
    tabId: senderTabId,
    sellerId: payload.sellerId.trim(),
    advertiserId: payload.advertiserId ?? null,
    shopName: payload.shopName ?? null,
    shopCode: payload.shopCode ?? null,
    shopRegion: payload.shopRegion ?? null,
    regionCode: payload.regionCode ?? null,
    progressPreserved: true,
    capturedFromBoundTab,
    sameSellerCenterOrigin,
    capturedFromTabId: senderTabId,
    boundTabId: current.boundTab?.tabId ?? null,
    pageOrigin: new URL(payload.url).origin,
  });
  await ensureBoundAlarms('configuration_ready');
  return next;
}

async function startAutomaticSellerBinding(deadlineAtMs?: number): Promise<void> {
  if (autoBindingPromise) return autoBindingPromise;
  const runId = ++autoBindingRunId;
  const promise = runAutomaticSellerBinding(runId, deadlineAtMs);
  let trackedPromise: Promise<void>;
  trackedPromise = promise.finally(() => {
    if (autoBindingPromise === trackedPromise) autoBindingPromise = null;
  });
  autoBindingPromise = trackedPromise;
  return trackedPromise;
}

async function runAutomaticSellerBinding(runId: number, requestedDeadlineAt?: number): Promise<void> {
  const deadlineAt = Number.isFinite(requestedDeadlineAt) && requestedDeadlineAt! > Date.now()
    ? requestedDeadlineAt!
    : Date.now() + AUTO_BIND_TIMEOUT_MS;
  const activated = await mutateOrderSyncState((current) => {
    if (runId !== autoBindingRunId
      || (current.sellerBinding.mode !== 'idle' && current.sellerBinding.mode !== 'auto')
      || (current.boundTab?.sellerId ?? '') !== '') return current;
    return {
      ...current,
      sellerBinding: {
        mode: 'auto',
        outcome: 'none',
        deadlineAt: new Date(deadlineAt).toISOString(),
      },
    };
  });
  if (activated.sellerBinding.mode !== 'auto') return;

  await recordOrderSyncRuntimeLog('all', 'seller_auto_bind_started', 'started', '访问令牌已配置，开始搜索可用的 Seller Center 页面并自动绑定。', {
    stage: 'seller_binding',
    timeoutMs: AUTO_BIND_TIMEOUT_MS,
    deadlineAt: new Date(deadlineAt).toISOString(),
    searchOrigins: ['https://seller.tiktokglobalshop.com', 'https://seller.tiktokshopglobalselling.com'],
  });

  let lastSearchError: string | null = null;
  let searchErrorLogged = false;
  let candidateFound = Boolean(activated.boundTab);
  while (Date.now() < deadlineAt && runId === autoBindingRunId) {
    const bindingState = await getOrderSyncState();
    if (bindingState.sellerBinding.mode !== 'auto') return;
    if (bindingState.boundTab?.sellerId) {
      await mutateOrderSyncState((current) => current.sellerBinding.mode === 'auto'
        ? {
          ...current,
          sellerBinding: { mode: 'idle', outcome: 'bound', deadlineAt: null },
        }
        : current);
      await recordOrderSyncRuntimeLog('all', 'seller_auto_bind_completed', 'succeeded', '自动绑定已完成，并成功捕获 Seller ID。', {
        stage: 'seller_binding',
        candidateFound,
        sellerIdCaptured: true,
      });
      return;
    }
    if (bindingState.boundTab) {
      candidateFound = true;
      await new Promise((resolve) => setTimeout(resolve, AUTO_BIND_POLL_INTERVAL_MS));
      continue;
    }

    let candidate: chrome.tabs.Tab | null = null;
    try {
      candidate = await findAutomaticSellerTab();
    } catch (error) {
      lastSearchError = error instanceof Error ? error.message : String(error);
      if (!searchErrorLogged) {
        searchErrorLogged = true;
        await recordOrderSyncRuntimeLog('all', 'seller_auto_bind_scan_failed', 'failed', '自动搜索 Seller Center 页面失败，将继续重试直到超时。', {
          stage: 'seller_binding',
          error: lastSearchError,
        });
      }
    }
    if (runId !== autoBindingRunId) return;
    if (candidate?.id !== undefined && candidate.url) {
      try {
        await autoBindInitialSellerTab(candidate);
      } catch (error) {
        let recovered = false;
        await mutateOrderSyncState((current) => {
          if (current.sellerBinding.mode !== 'auto') return current;
          recovered = true;
          return {
            ...current,
            boundTab: current.boundTab?.sellerId ? current.boundTab : null,
            sellerBinding: { mode: 'idle', outcome: 'failed', deadlineAt: null },
          };
        });
        if (recovered) await ensureBoundAlarms('configuration_ready');
        await recordOrderSyncRuntimeLog('all', 'seller_auto_bind_failed', 'failed', '本轮自动绑定 Seller Center 页面失败，将按定时扫描继续重试。', {
          stage: 'seller_binding',
          tabId: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      candidateFound = true;
      await probeAndCaptureSellerIdentity(candidate);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, AUTO_BIND_POLL_INTERVAL_MS));
  }

  if (runId !== autoBindingRunId) return;
  let timedOut = false;
  let sellerIdCapturedAtTimeout = false;
  await mutateOrderSyncState((current) => {
    if (current.sellerBinding.mode !== 'auto') return current;
    timedOut = true;
    const sellerCaptured = Boolean(current.boundTab?.sellerId);
    sellerIdCapturedAtTimeout = sellerCaptured;
    return {
      ...current,
      boundTab: sellerCaptured ? current.boundTab : null,
      sellerBinding: {
        mode: 'idle',
        outcome: sellerCaptured ? 'bound' : 'timeout',
        deadlineAt: null,
      },
    };
  });
  if (timedOut) await ensureBoundAlarms('configuration_ready');
  await recordOrderSyncRuntimeLog('all', 'seller_auto_bind_timeout', 'skipped', '本轮 10 秒自动扫描未完成，将在下一次定时扫描继续重试。', {
    stage: 'seller_binding',
    timeoutMs: AUTO_BIND_TIMEOUT_MS,
    candidateFound,
    sellerIdCaptured: sellerIdCapturedAtTimeout,
    lastSearchError,
  });
}

async function findAutomaticSellerTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({});
  const sellerTabs = tabs
    .filter((tab) => tab.id !== undefined && tab.url && isSellerCenterUrl(tab.url)
      && !isTikTokLoginPage(tab.url));
  const pinnedSellerTabs = sellerTabs.filter((tab) => tab.pinned === true);
  const candidatePool = pinnedSellerTabs.length > 0 ? pinnedSellerTabs : sellerTabs;
  const candidate = candidatePool
    .filter((tab) => tab.discarded !== true && tab.status !== 'loading')
    .sort(compareSellerCenterTabs)[0] ?? null;
  if (!candidate && pinnedSellerTabs.length > 0) {
    const discardedPinnedTab = pinnedSellerTabs.find((tab) => tab.discarded === true);
    if (discardedPinnedTab?.id !== undefined) {
      const decision = await claimSharedSellerPageRefresh(discardedPinnedTab.id, 0).catch(() => null);
      if (decision?.allowed) await chrome.tabs.reload(discardedPinnedTab.id).catch(() => undefined);
    }
  }
  return candidate;
}

async function autoBindInitialSellerTab(candidate: chrome.tabs.Tab): Promise<void> {
  const tabId = candidate.id!;
  const tabUrl = candidate.url!;
  const candidateWasPinned = candidate.pinned === true;
  await mutateOrderSyncState((current) => {
    if (current.sellerBinding.mode !== 'auto' || current.boundTab) {
      throw new Error('自动绑定状态已结束。');
    }
    return {
      ...current,
      boundTab: {
        tabId,
        url: tabUrl,
        bindMode: 'auto',
        boundAt: new Date().toISOString(),
      },
    };
  });
  if (!candidateWasPinned) await pinSellerTab(tabId, 'auto_bind');
  await recordOrderSyncRuntimeLog('all', 'seller_auto_bind_requested', 'started', '已自动绑定可用的 Seller Center 页面，不刷新当前页面，等待接口请求捕获 Seller ID。', {
    stage: 'seller_binding',
    tabId,
    pageOrigin: new URL(tabUrl).origin,
    reloadRequested: false,
    reusedPinnedTab: candidateWasPinned,
  });
  await ensureBoundAlarms('configuration_ready');
}

async function probeAndCaptureSellerIdentity(candidate: chrome.tabs.Tab): Promise<boolean> {
  if (candidate.id === undefined || !candidate.url) return false;
  try {
    await recordOrderSyncRuntimeLog('all', 'seller_identity_probe_started', 'started', '已主动请求 Seller Center 店铺信息接口。', {
      stage: 'seller_binding',
      tabId: candidate.id,
      pageOrigin: new URL(candidate.url).origin,
      requestType: 'GET',
      endpointPath: '/api/v3/seller/common/get',
      timeoutMs: 2_500,
    });
    const probe = await probeSellerIdentityInBoundPage(candidate.id);
    const captured = await captureSellerIdentity({
      sellerId: probe.identity.sellerId,
      url: candidate.url,
      ...(probe.identity.shopName ? { shopName: probe.identity.shopName } : {}),
      ...(probe.identity.shopCode ? { shopCode: probe.identity.shopCode } : {}),
      ...(probe.identity.shopRegion ? { shopRegion: probe.identity.shopRegion } : {}),
      ...(probe.identity.regionCode ? { regionCode: probe.identity.regionCode } : {}),
    }, { tab: { id: candidate.id } as chrome.tabs.Tab });
    const stateBound = Boolean(captured.boundTab?.sellerId);
    await recordOrderSyncRuntimeLog('all', 'seller_identity_probe_succeeded', 'succeeded', '已主动获取并写入 Seller Center 店铺信息。', {
      stage: 'seller_binding',
      tabId: candidate.id,
      sellerId: probe.identity.sellerId,
      shopName: probe.identity.shopName ?? null,
      shopCode: probe.identity.shopCode ?? null,
      shopRegion: probe.identity.shopRegion ?? null,
      regionCode: probe.identity.regionCode ?? null,
      requestMode: probe.response.requestMode ?? null,
      httpStatus: probe.response.status,
      stateBound,
    });
    return stateBound;
  } catch (error) {
    const probeResponse = isRecord(error) && 'response' in error ? error.response : null;
    await recordOrderSyncRuntimeLog('all', 'seller_identity_probe_failed', 'failed', '主动获取 Seller Center 店铺信息失败，将由定时扫描继续重试。', {
      stage: 'seller_binding',
      tabId: candidate.id,
      error: error instanceof Error ? error.message : String(error),
      httpStatus: isRecord(probeResponse) && typeof probeResponse.status === 'number' ? probeResponse.status : null,
      requestMode: isRecord(probeResponse) && typeof probeResponse.requestMode === 'string' ? probeResponse.requestMode : null,
    });
    return false;
  }
}

async function handleBoundTabRemoved(tabId: number): Promise<void> {
  const current = await getOrderSyncState();
  if (current.boundTab?.tabId !== tabId) return;
  const replacement = await findReplacementSellerTab(tabId);
  if (replacement?.id !== undefined && replacement.url) {
    await autoRebindSellerTab(current.boundTab, replacement, 'bound_tab_removed');
    return;
  }
  await mutateOrderSyncState((state) => {
    if (!state.boundTab) return state;
    const { sellerId: _sellerId, ...withoutSellerId } = state.boundTab;
    return { ...state, boundTab: withoutSellerId };
  });
  await recordOrderSyncRuntimeLog('all', 'seller_auto_rebind_unavailable', 'skipped', '绑定 Seller Center 页面已关闭，暂未找到可用候选页面。', {
    stage: 'seller_binding',
    reason: 'bound_tab_removed_without_replacement',
    closedTabId: tabId,
    preservedProgress: true,
    syncStopped: true,
    replacementScanScheduled: true,
  });
  await ensureBoundAlarms('configuration_ready');
}

async function handleLoginRedirect(tabId: number): Promise<void> {
  const current = await getOrderSyncState();
  if (current.boundTab?.tabId !== tabId) return;
  const replacement = await findReplacementSellerTab(tabId);
  if (replacement?.id !== undefined && replacement.url) {
    await autoRebindSellerTab(current.boundTab, replacement, 'bound_tab_login_redirect');
    return;
  }
  await mutateOrderSyncState((state) => {
    if (!state.boundTab) return state;
    const { sellerId: _sellerId, ...withoutSellerId } = state.boundTab;
    return { ...state, boundTab: { ...withoutSellerId, url: `https://${new URL(state.boundTab.url).host}/account/login` } };
  });
  await recordOrderSyncRuntimeLog('all', 'seller_login_redirect', 'skipped', '绑定页面进入登录页，保留同步断点等待重新登录。', {
    stage: 'seller_binding',
    tabId,
    preservedProgress: true,
  });
  await ensureBoundAlarms('configuration_ready');
}

async function handleBoundTabPinChanged(tabId: number, pinned: boolean): Promise<void> {
  const current = await getOrderSyncState();
  if (current.boundTab?.tabId !== tabId) return;
  if (!pinned) await pinSellerTab(tabId, 'binding_repair');
  await ensureBoundSellerTabRefreshAlarm();
}

async function handleBoundTabNavigation(tabId: number, url: string): Promise<void> {
  const current = await getOrderSyncState();
  if (current.boundTab?.tabId !== tabId) return;
  if (isTikTokLoginPage(url)) {
    await handleLoginRedirect(tabId);
    return;
  }
  if (isSellerCenterUrl(url)) {
    if (current.boundTab.url !== url) {
      await mutateOrderSyncState((state) => state.boundTab?.tabId === tabId
        ? { ...state, boundTab: { ...state.boundTab, url } }
        : state);
    }
    await ensureBoundSellerTabRefreshAlarm();
    return;
  }

  const replacement = await findReplacementSellerTab(tabId);
  if (replacement?.id !== undefined && replacement.url) {
    await autoRebindSellerTab(current.boundTab, replacement, 'bound_tab_navigation');
    return;
  }
  await mutateOrderSyncState((state) => {
    if (state.boundTab?.tabId !== tabId) return state;
    const { sellerId: _sellerId, ...withoutSellerId } = state.boundTab;
    return { ...state, boundTab: { ...withoutSellerId, url } };
  });
  await recordOrderSyncRuntimeLog('all', 'seller_tab_navigation_invalid', 'skipped', '绑定页面已离开 Seller Center，暂停同步并等待可用页面。', {
    stage: 'seller_binding',
    tabId,
    pageUrl: url,
    replacementScanScheduled: true,
  });
  await ensureBoundAlarms('configuration_ready');
}

async function findReplacementSellerTab(excludedTabId?: number): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({});
  const sellerTabs = tabs
    .filter((tab) => tab.id !== undefined && tab.id !== excludedTabId && isSellerCenterUrl(tab.url)
      && !isTikTokLoginPage(tab.url ?? ''));
  const pinnedSellerTabs = sellerTabs.filter((tab) => tab.pinned === true);
  const candidatePool = pinnedSellerTabs.length > 0 ? pinnedSellerTabs : sellerTabs;
  const candidate = candidatePool
    .filter((tab) => tab.discarded !== true && tab.status !== 'loading')
    .sort(compareSellerCenterTabs)[0] ?? null;
  if (!candidate && pinnedSellerTabs.length > 0) {
    const discardedPinnedTab = pinnedSellerTabs.find((tab) => tab.discarded === true);
    if (discardedPinnedTab?.id !== undefined) {
      const decision = await claimSharedSellerPageRefresh(discardedPinnedTab.id, 0).catch(() => null);
      if (decision?.allowed) await chrome.tabs.reload(discardedPinnedTab.id).catch(() => undefined);
    }
  }
  return candidate;
}

async function scanForReplacementSellerTab(): Promise<void> {
  const current = await getOrderSyncState();
  if (!current.settings.syncBaseUrl.trim() || !current.settings.syncToken.trim() || current.boundTab?.sellerId) {
    await chrome.alarms.clear(SELLER_TAB_ALARMS.watch);
    return;
  }

  if (!current.boundTab) {
    await startAutomaticSellerBinding();
    await ensureSellerBindingWatchAlarm();
    return;
  }

  try {
    const currentTab = await chrome.tabs.get(current.boundTab.tabId);
    if (isSellerCenterUrl(currentTab.url) && !isTikTokLoginPage(currentTab.url ?? '')) {
      await probeAndCaptureSellerIdentity(currentTab);
      await ensureSellerBindingWatchAlarm();
      return;
    }
  } catch {
    // The previously bound tab is gone; continue looking for a replacement.
  }

  const replacement = await findReplacementSellerTab(current.boundTab.tabId);
  if (replacement?.id !== undefined && replacement.url) {
    await autoRebindSellerTab(current.boundTab, replacement, 'bound_tab_removed');
    return;
  }

  await ensureSellerBindingWatchAlarm();
}

async function autoRebindSellerTab(
  previousBoundTab: NonNullable<OrderSyncState['boundTab']>,
  replacement: chrome.tabs.Tab,
  reason: 'bound_tab_removed' | 'bound_tab_login_redirect' | 'bound_tab_navigation',
): Promise<void> {
  const tabId = replacement.id!;
  const tabUrl = replacement.url!;
  await mutateOrderSyncState((current) => ({
    ...current,
    boundTab: {
      ...previousBoundTab,
      tabId,
      url: tabUrl,
      bindMode: 'auto',
      boundAt: new Date().toISOString(),
    },
  }));
  if (replacement.pinned !== true) await pinSellerTab(tabId, 'auto_rebind');
  await recordOrderSyncRuntimeLog('all', 'seller_auto_rebind_requested', 'started', '已自动切换到可用的 Seller Center 页面。', {
    stage: 'seller_binding',
    reason,
    previousTabId: previousBoundTab.tabId,
    replacementTabId: tabId,
    pageOrigin: new URL(tabUrl).origin,
    preservedProgress: true,
  });
  await recordOrderSyncRuntimeLog('all', 'seller_auto_rebind_ready', 'succeeded', '已自动接管可用的 Seller Center 页面，不刷新当前页面，继续使用现有会话。', {
    stage: 'seller_binding',
    reason,
    replacementTabId: tabId,
    reloadRequested: false,
    preservedSellerId: Boolean(previousBoundTab.sellerId),
  });
  await ensureBoundAlarms('configuration_ready');
}

async function pinSellerTab(
  tabId: number,
  reason: 'manual_bind' | 'auto_bind' | 'auto_rebind' | 'binding_repair',
): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { pinned: true });
    await recordOrderSyncRuntimeLog('all', 'seller_tab_pinned', 'succeeded', '已固定绑定的 Seller Center 页面。', {
      stage: 'seller_binding',
      tabId,
      reason,
    });
  } catch (error) {
    await recordOrderSyncRuntimeLog('all', 'seller_tab_pin_failed', 'failed', '绑定页面固定失败，不影响当前同步流程。', {
      stage: 'seller_binding',
      tabId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function ensureBoundAlarms(
  initialSyncTrigger: Parameters<typeof ensureBoundDomainAlarms>[0] = 'extension_startup',
): Promise<void> {
  await ensureBoundDomainAlarms(initialSyncTrigger);
  await ensureBoundSellerTabRefreshAlarm();
  await ensureSellerBindingWatchAlarm();
}

async function ensureBoundSellerTabRefreshAlarm(): Promise<void> {
  const state = await getOrderSyncState();
  const tabId = state.boundTab?.tabId;
  if (tabId === undefined) {
    await chrome.alarms.clear(SELLER_TAB_ALARMS.refresh);
    return;
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    await chrome.alarms.clear(SELLER_TAB_ALARMS.refresh);
    return;
  }
  if (tab.pinned !== true || !isSellerCenterUrl(tab.url) || isTikTokLoginPage(tab.url ?? '')) {
    await chrome.alarms.clear(SELLER_TAB_ALARMS.refresh);
    return;
  }

  const existing = await chrome.alarms.get(SELLER_TAB_ALARMS.refresh);
  if (!existing) {
    await chrome.alarms.create(SELLER_TAB_ALARMS.refresh, {
      delayInMinutes: SELLER_TAB_REFRESH_DELAY_MINUTES,
    });
  }
}

async function ensureSellerBindingWatchAlarm(): Promise<void> {
  const state = await getOrderSyncState();
  if (!state.settings.syncBaseUrl.trim() || !state.settings.syncToken.trim() || state.boundTab?.sellerId) {
    await chrome.alarms.clear(SELLER_TAB_ALARMS.watch);
    return;
  }

  const existing = await chrome.alarms.get(SELLER_TAB_ALARMS.watch);
  if (!existing) {
    await chrome.alarms.create(SELLER_TAB_ALARMS.watch, {
      delayInMinutes: SELLER_TAB_WATCH_DELAY_MINUTES,
    });
  }
}

async function refreshBoundSellerTab(): Promise<void> {
  const state = await getOrderSyncState();
  const boundTab = state.boundTab;
  if (!boundTab) {
    await chrome.alarms.clear(SELLER_TAB_ALARMS.refresh);
    return;
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(boundTab.tabId);
  } catch {
    await chrome.alarms.clear(SELLER_TAB_ALARMS.refresh);
    await recordOrderSyncRuntimeLog('all', 'seller_tab_refresh_skipped', 'skipped', '绑定页面已不存在，跳过定时刷新。', {
      stage: 'seller_binding',
      tabId: boundTab.tabId,
      reason: 'bound_tab_missing',
    });
    return;
  }

  if (tab.pinned !== true || !isSellerCenterUrl(tab.url) || isTikTokLoginPage(tab.url ?? '')) {
    await chrome.alarms.clear(SELLER_TAB_ALARMS.refresh);
    await recordOrderSyncRuntimeLog('all', 'seller_tab_refresh_skipped', 'skipped', '绑定页面未处于固定且已登录状态，跳过定时刷新。', {
      stage: 'seller_binding',
      tabId: boundTab.tabId,
      reason: tab.pinned !== true ? 'tab_not_pinned' : 'seller_center_login_or_invalid_url',
    });
    return;
  }

  const syncLocks = getOrderSyncLockSnapshot();
  if (syncLocks.manualStartPending || syncLocks.ordersInFlight || syncLocks.domainsInFlight.length > 0) {
    await recordOrderSyncRuntimeLog('all', 'seller_tab_refresh_skipped', 'skipped', '固定 Seller Center 页面正在执行订单域请求，延后刷新。', {
      stage: 'seller_binding',
      tabId: boundTab.tabId,
      reason: 'active_order_sync',
      syncLocks,
      retryInMinutes: SELLER_TAB_REFRESH_RETRY_MINUTES,
    });
    await scheduleBoundSellerTabRefresh(SELLER_TAB_REFRESH_RETRY_MINUTES);
    return;
  }

  const refreshDecision = await claimSharedSellerPageRefresh(
    boundTab.tabId,
    SELLER_TAB_REFRESH_MINIMUM_AGE_MS,
  );
  if (!refreshDecision.allowed) {
    const retryInMinutes = Math.min(
      SELLER_TAB_REFRESH_DELAY_MINUTES,
      Math.max(1, Math.ceil(refreshDecision.retryAfterMs / 60_000)),
    );
    await recordOrderSyncRuntimeLog('all', 'seller_tab_refresh_skipped', 'skipped', '共享 Seller Center 页面正在使用或最近已刷新，延后本插件刷新。', {
      stage: 'seller_binding',
      tabId: boundTab.tabId,
      reason: refreshDecision.reason,
      pageAgeMs: refreshDecision.pageAgeMs,
      activeRequestCount: refreshDecision.activeRequestCount,
      retryAfterMs: refreshDecision.retryAfterMs,
      retryInMinutes,
    });
    await scheduleBoundSellerTabRefresh(retryInMinutes);
    return;
  }

  try {
    await chrome.tabs.reload(boundTab.tabId, { bypassCache: true });
    await recordOrderSyncRuntimeLog('all', 'seller_tab_refreshed', 'succeeded', '已按 2 小时周期刷新固定的 Seller Center 页面，保持会话有效。', {
      stage: 'seller_binding',
      tabId: boundTab.tabId,
      intervalMinutes: SELLER_TAB_REFRESH_DELAY_MINUTES,
    });
  } catch (error) {
    await recordOrderSyncRuntimeLog('all', 'seller_tab_refresh_failed', 'failed', '固定 Seller Center 页面定时刷新失败。', {
      stage: 'seller_binding',
      tabId: boundTab.tabId,
      error: error instanceof Error ? error.message : String(error),
    });
    await scheduleBoundSellerTabRefresh(SELLER_TAB_REFRESH_RETRY_MINUTES);
    return;
  }

  await scheduleBoundSellerTabRefresh(SELLER_TAB_REFRESH_DELAY_MINUTES);
}

async function scheduleBoundSellerTabRefresh(delayInMinutes: number): Promise<void> {
  const state = await getOrderSyncState();
  if (!state.boundTab) {
    await chrome.alarms.clear(SELLER_TAB_ALARMS.refresh);
    return;
  }
  await chrome.alarms.clear(SELLER_TAB_ALARMS.refresh);
  await chrome.alarms.create(SELLER_TAB_ALARMS.refresh, {
    delayInMinutes: Math.max(1, delayInMinutes),
  });
}

async function claimSharedSellerPageRefresh(
  tabId: number,
  minimumPageAgeMs: number,
): Promise<SellerPageRefreshDecision> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: claimSellerPageRefresh,
    args: [
      SELLER_PAGE_COORDINATION_KEY,
      minimumPageAgeMs,
      SELLER_PAGE_REFRESH_CLAIM_MS,
      SELLER_PAGE_REFRESH_QUIET_MS,
    ],
  });
  return results[0]?.result ?? {
    allowed: false,
    reason: 'coordination_unavailable',
    pageAgeMs: 0,
    retryAfterMs: 60_000,
    activeRequestCount: 0,
  };
}

function compareSellerCenterTabs(left: chrome.tabs.Tab, right: chrome.tabs.Tab): number {
  return Number(right.pinned === true) - Number(left.pinned === true)
    || Number(isSellerCenterAdsPage(right.url)) - Number(isSellerCenterAdsPage(left.url))
    || Number(Boolean(right.active)) - Number(Boolean(left.active))
    || (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0)
    || (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER);
}

function isSellerCenterAdsPage(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return isSellerCenterUrl(value) && url.pathname.startsWith('/ads-creation');
  } catch {
    return false;
  }
}

async function clearOrderAlarms(): Promise<void> {
  await Promise.all([
    ...Object.values(ORDER_SYNC_ALARMS),
    ...Object.values(SELLER_TAB_ALARMS),
  ].map((name) => chrome.alarms.clear(name)));
}

function isSellerCenterUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://seller.tiktokglobalshop.com'
      || url.origin === 'https://seller.tiktokshopglobalselling.com';
  } catch { return false; }
}

function isTikTokLoginPage(value: string): boolean {
  try {
    const url = new URL(value);
    return isSellerCenterUrl(value) && url.pathname.replace(/\/+$/, '') === '/account/login';
  } catch { return false; }
}

function isHttpUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; }
  catch { return false; }
}

function reportError(error: unknown, source = 'background'): void {
  console.error('[order-data-sync]', error);
  void recordOrderSyncRuntimeLog('all', 'background_error', 'failed', '后台事件处理异常。', {
    stage: 'background',
    source,
    error: error instanceof Error ? error.message : String(error),
  }).catch((loggingError) => console.error('[order-data-sync] log failure', loggingError));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
