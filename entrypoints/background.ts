import { defineBackground } from 'wxt/utils/define-background';
import { normalizeOrderSyncBaseUrl, normalizeOrderSyncSettings } from '../src/core/settings';
import type { OrderExtensionMessage } from '../src/extension/messages';
import { createDefaultOrderProgress, getOrderSyncState, mutateOrderSyncState } from '../src/extension/storage';
import type { OrderDomainKey, OrderSyncState } from '../src/core/types';
import {
  ensureBoundDomainAlarms,
  handleOrderSyncAlarm,
  ORDER_SYNC_ALARMS,
  pollOrderDomain,
  recordOrderSyncRuntimeLog,
  reportSchedulerError,
  requestManualOrderDomainSync,
  runInitialOrderDomainSync,
  SELLER_TAB_ALARMS,
  SELLER_TAB_WATCH_DELAY_MINUTES,
  stopStuckOrderDomainAndRetry,
} from '../src/extension/order-engine';

const SELLER_TAB_REFRESH_DELAY_MINUTES = 120;

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
      void ensureBoundSellerTabRefreshAlarm().catch(reportSchedulerError);
    }
    if (changeInfo.url && isTikTokLoginPage(changeInfo.url)) {
      void handleLoginRedirect(tabId).catch((error) => reportError(error, 'login_redirect'));
    }
  });

  void getOrderSyncState().catch((error) => reportError(error, 'extension_startup'));
  void ensureBoundAlarms('extension_startup').catch(reportSchedulerError);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ORDER_SYNC_ALARMS.orders || alarm.name === ORDER_SYNC_ALARMS.ordersContinue) {
      void handleOrderSyncAlarm().catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    } else if (alarm.name === ORDER_SYNC_ALARMS.logistics || alarm.name === ORDER_SYNC_ALARMS.logisticsContinue) {
      void pollOrderDomain('logistics').catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    } else if (alarm.name === ORDER_SYNC_ALARMS.statements || alarm.name === ORDER_SYNC_ALARMS.statementsContinue) {
      void pollOrderDomain('statements').catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    } else if (alarm.name === SELLER_TAB_ALARMS.refresh) {
      void refreshBoundSellerTab().catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    } else if (alarm.name === SELLER_TAB_ALARMS.watch) {
      void scanForReplacementSellerTab().catch((error) => reportSchedulerError(error, { alarmName: alarm.name }));
    }
  });
});

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
      const next = await mutateOrderSyncState((current) => {
        const destinationChanged = normalizeOrderSyncBaseUrl(current.settings.syncBaseUrl)
          !== normalizeOrderSyncBaseUrl(settings.syncBaseUrl)
          || current.settings.syncToken.trim() !== settings.syncToken.trim();
        return {
          ...current,
          settings,
          ...(destinationChanged ? {
            shopRegion: null,
            orderProgress: createDefaultOrderProgress(),
          } : {}),
        };
      });
      await ensureBoundAlarms('configuration_ready');
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
  if (!tab?.id || !isSellerCenterUrl(tab.url)) throw new Error('请先打开 TikTok Shop Seller Center 页面。');
  const bound = await mutateOrderSyncState((current) => ({
    ...current,
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
  }));
  await pinSellerTab(tab.id, 'manual_bind');
  await recordOrderSyncRuntimeLog('all', 'seller_bind_requested', 'started', '已绑定当前 Seller Center 页面，准备刷新并捕获 Seller ID。', {
    stage: 'seller_binding',
    tabId: tab.id,
    pageOrigin: new URL(tab.url!).origin,
    pagePath: new URL(tab.url!).pathname,
    reloadRequested: true,
  });
  // Install the document_start identity and page proxy hooks on an already-open tab.
  try {
    await chrome.tabs.reload(tab.id, { bypassCache: true });
  } catch (error) {
    await recordOrderSyncRuntimeLog('all', 'seller_bind_reload_failed', 'failed', 'Seller Center 页面刷新失败，尚未完成 Seller ID 捕获。', {
      stage: 'seller_binding',
      tabId: tab.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await recordOrderSyncRuntimeLog('all', 'seller_bind_reloaded', 'succeeded', 'Seller Center 页面已刷新，等待页面请求中的 Seller ID。', {
    stage: 'seller_binding',
    tabId: tab.id,
  });
  await ensureBoundAlarms();
  return bound;
}

async function unbindCurrentSellerTab(): Promise<OrderSyncState> {
  const next = await mutateOrderSyncState((state) => ({ ...state, boundTab: null, shopRegion: null }));
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
  if (current.boundTab?.tabId !== senderTabId) {
    await recordOrderSyncRuntimeLog('all', 'seller_identity_ignored', 'skipped', '忽略非当前绑定页面的 Seller ID 捕获消息。', {
      stage: 'seller_binding',
      reason: 'sender_tab_not_bound',
      senderTabId,
      boundTabId: current.boundTab?.tabId ?? null,
    });
    return current;
  }
  const next = await mutateOrderSyncState((current) => {
    if (current.boundTab?.tabId !== senderTabId) return current;
    const sellerId = payload.sellerId.trim();
    return {
      ...current,
      boundTab: {
        ...current.boundTab,
        url: payload.url,
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
    pageOrigin: new URL(payload.url).origin,
  });
  await ensureBoundAlarms('configuration_ready');
  return next;
}

async function handleBoundTabRemoved(tabId: number): Promise<void> {
  const current = await getOrderSyncState();
  if (current.boundTab?.tabId !== tabId) return;
  const replacement = await findReplacementSellerTab(current.boundTab, tabId);
  if (replacement?.id !== undefined && replacement.url) {
    await autoRebindSellerTab(current.boundTab, replacement, 'bound_tab_removed');
    return;
  }
  await mutateOrderSyncState((state) => {
    if (!state.boundTab) return state;
    const { sellerId: _sellerId, ...withoutSellerId } = state.boundTab;
    return { ...state, boundTab: withoutSellerId };
  });
  await recordOrderSyncRuntimeLog('all', 'seller_auto_rebind_unavailable', 'skipped', '绑定 Seller Center 页面已关闭，暂未找到同域名候选页面。', {
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
  const replacement = await findReplacementSellerTab(current.boundTab, tabId);
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

async function findReplacementSellerTab(
  previousBoundTab: NonNullable<OrderSyncState['boundTab']>,
  excludedTabId?: number,
): Promise<chrome.tabs.Tab | null> {
  const previousOrigin = new URL(previousBoundTab.url).origin;
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab.id !== undefined && tab.id !== excludedTabId && isSellerCenterUrl(tab.url)
      && !isTikTokLoginPage(tab.url ?? '')
      && new URL(tab.url!).origin === previousOrigin)
    .sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active))
      || (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ?? null;
}

async function scanForReplacementSellerTab(): Promise<void> {
  const current = await getOrderSyncState();
  if (!current.boundTab || current.boundTab.sellerId) {
    await chrome.alarms.clear(SELLER_TAB_ALARMS.watch);
    return;
  }

  try {
    const currentTab = await chrome.tabs.get(current.boundTab.tabId);
    if (isSellerCenterUrl(currentTab.url) && !isTikTokLoginPage(currentTab.url ?? '')) {
      await ensureSellerBindingWatchAlarm();
      return;
    }
  } catch {
    // The previously bound tab is gone; continue looking for a replacement.
  }

  const replacement = await findReplacementSellerTab(current.boundTab, current.boundTab.tabId);
  if (replacement?.id !== undefined && replacement.url) {
    await autoRebindSellerTab(current.boundTab, replacement, 'bound_tab_removed');
    return;
  }

  await ensureSellerBindingWatchAlarm();
}

async function autoRebindSellerTab(
  previousBoundTab: NonNullable<OrderSyncState['boundTab']>,
  replacement: chrome.tabs.Tab,
  reason: 'bound_tab_removed' | 'bound_tab_login_redirect',
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
  await pinSellerTab(tabId, 'auto_rebind');
  await recordOrderSyncRuntimeLog('all', 'seller_auto_rebind_requested', 'started', '已自动切换到同域名 Seller Center 页面。', {
    stage: 'seller_binding',
    reason,
    previousTabId: previousBoundTab.tabId,
    replacementTabId: tabId,
    pageOrigin: new URL(tabUrl).origin,
    preservedProgress: true,
  });
  await recordOrderSyncRuntimeLog('all', 'seller_auto_rebind_ready', 'succeeded', '已自动接管同域名 Seller Center 页面，不刷新当前页面，继续使用现有会话。', {
    stage: 'seller_binding',
    reason,
    replacementTabId: tabId,
    reloadRequested: false,
    preservedSellerId: Boolean(previousBoundTab.sellerId),
  });
  await ensureBoundAlarms('configuration_ready');
}

async function pinSellerTab(tabId: number, reason: 'manual_bind' | 'auto_rebind'): Promise<void> {
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
  if (!state.boundTab || state.boundTab.sellerId) {
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
  }

  await ensureBoundSellerTabRefreshAlarm();
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
