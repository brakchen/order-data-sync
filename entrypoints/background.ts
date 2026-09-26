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
  reportSchedulerError,
  requestManualOrderDomainSync,
  runInitialOrderDomainSync,
  stopStuckOrderDomainAndRetry,
} from '../src/extension/order-engine';

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
    void handleBoundTabRemoved(tabId).catch(reportError);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url || !isTikTokLoginPage(changeInfo.url)) return;
    void handleLoginRedirect(tabId).catch(reportError);
  });

  void getOrderSyncState().catch(reportError);
  void ensureBoundDomainAlarms('extension_startup').catch(reportSchedulerError);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ORDER_SYNC_ALARMS.orders || alarm.name === ORDER_SYNC_ALARMS.ordersContinue) {
      void handleOrderSyncAlarm().catch(reportSchedulerError);
    } else if (alarm.name === ORDER_SYNC_ALARMS.logistics || alarm.name === ORDER_SYNC_ALARMS.logisticsContinue) {
      void pollOrderDomain('logistics').catch(reportSchedulerError);
    } else if (alarm.name === ORDER_SYNC_ALARMS.statements || alarm.name === ORDER_SYNC_ALARMS.statementsContinue) {
      void pollOrderDomain('statements').catch(reportSchedulerError);
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
      await ensureBoundDomainAlarms('configuration_ready');
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
      ...(current.boundTab && current.boundTab.tabId === tab.id && current.boundTab.sellerId
        ? { sellerId: current.boundTab.sellerId }
        : {}),
      bindMode: 'manual',
      boundAt: new Date().toISOString(),
    },
    ...(current.boundTab?.tabId === tab.id ? {} : { shopRegion: null }),
  }));
  // Install the document_start identity and page proxy hooks on an already-open tab.
  await chrome.tabs.reload(tab.id);
  await ensureBoundDomainAlarms();
  return bound;
}

async function unbindCurrentSellerTab(): Promise<OrderSyncState> {
  const next = await mutateOrderSyncState((state) => ({ ...state, boundTab: null, shopRegion: null }));
  await clearOrderAlarms();
  return next;
}

async function captureSellerIdentity(
  payload: { sellerId: string; url: string; advertiserId?: string },
  sender: chrome.runtime.MessageSender,
): Promise<OrderSyncState> {
  const senderTabId = sender.tab?.id;
  if (senderTabId === undefined || !isSellerCenterUrl(payload.url) || !payload.sellerId.trim()) return getOrderSyncState();
  const next = await mutateOrderSyncState((current) => {
    if (current.boundTab?.tabId !== senderTabId) return current;
    const sellerId = payload.sellerId.trim();
    const sellerChanged = current.boundTab.sellerId !== sellerId;
    return {
      ...current,
      boundTab: {
        ...current.boundTab,
        url: payload.url,
        sellerId,
        ...(payload.advertiserId ? { advertiserId: payload.advertiserId } : {}),
      },
      ...(sellerChanged ? {
        shopRegion: null,
        orderProgress: createDefaultOrderProgress(),
      } : {}),
    };
  });
  await ensureBoundDomainAlarms('configuration_ready');
  return next;
}

async function handleBoundTabRemoved(tabId: number): Promise<void> {
  const current = await getOrderSyncState();
  if (current.boundTab?.tabId !== tabId) return;
  await mutateOrderSyncState((state) => ({ ...state, boundTab: null, shopRegion: null }));
  await clearOrderAlarms();
}

async function handleLoginRedirect(tabId: number): Promise<void> {
  const current = await getOrderSyncState();
  if (current.boundTab?.tabId !== tabId) return;
  await mutateOrderSyncState((state) => ({ ...state, boundTab: null, shopRegion: null }));
  await clearOrderAlarms();
}

async function clearOrderAlarms(): Promise<void> {
  await Promise.all(Object.values(ORDER_SYNC_ALARMS).map((name) => chrome.alarms.clear(name)));
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

function reportError(error: unknown): void {
  console.error('[order-data-sync]', error);
}
