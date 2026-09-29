import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { OrderExtensionMessage } from '../../src/extension/messages';
import { createPopupApplicationState } from '../../src/extension/popup-application-state';
import type { OrderDisplayDomainKey, OrderSyncState } from '../../src/core/types';
import './style.css';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
const DOMAIN_LABELS: Record<OrderDisplayDomainKey, string> = {
  orders: '订单', logistics: '物流', statements: '结算',
  after_sales: '售后',
  order_details: '订单详情', order_history: '订单历史',
};
const DOMAIN_DESCRIPTIONS: Record<OrderDisplayDomainKey, string> = {
  orders: '读取订单列表并上传订单主数据',
  logistics: '读取每个订单的物流详情',
  statements: '读取结算单及结算明细',
  after_sales: '读取退款、退货和取消等售后数据',
  order_details: '读取订单商品、金额和买家详情',
  order_history: '读取订单状态变更历史',
};
const DISPLAY_DOMAINS: readonly OrderDisplayDomainKey[] = [
  'orders', 'logistics', 'statements', 'after_sales', 'order_details', 'order_history',
];

function Popup() {
  const application = useMemo(() => createPopupApplicationState({
    loadState: () => send<OrderSyncState>({ type: 'order-sync:get-state' }),
    saveSettings: (settings) => send<OrderSyncState>({ type: 'order-sync:save-settings', settings }),
    syncDomains: (retryFailedOnly) => send<OrderSyncState>({ type: 'order-sync:sync-domains', retryFailedOnly }),
    stopStuckDomain: (domain) => send<OrderSyncState>({ type: 'order-sync:stop-stuck-domain', domain }),
    schedule: (task, delayMs) => window.setTimeout(task, delayMs),
    cancel: (handle) => window.clearTimeout(handle),
  }), []);
  const { state, draft, busy, notice } = useSyncExternalStore(
    application.subscribe,
    application.getSnapshot,
  );

  useEffect(() => {
    void application.initialize();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.orderSyncState) void application.refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, [application]);

  const exportLogs = () => {
    const exported = application.exportLogs(chrome.runtime.getManifest().version);
    if (!exported) return;
    const blob = new Blob([exported.contents], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exported.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const readyToSync = Boolean(state?.boundTab?.sellerId && state.settings.syncToken.trim()
    && state.settings.orderDomainSyncEnabled && !state.settings.syncPaused);
  const automaticBinding = state?.sellerBinding.mode === 'auto';
  const automaticBindingTimedOut = state?.sellerBinding.outcome === 'timeout';
  const hasFailures = DISPLAY_DOMAINS.some((domain) => {
    const row = state?.orderProgress.domains[domain];
    return Boolean(row && (row.lastError || row.pending > 0 || (row.failed ?? 0) > 0
      || row.syncRunStatus === 'partial_failed' || row.syncRunStatus === 'interrupted'));
  });

  return (
    <main className="shell">
      <header className="header">
        <div className="mark"><img src="/icons/icon-128.png" alt="" /></div>
        <div><p className="eyebrow">TIKTOK SHOP</p><h1>订单数据同步</h1></div>
        <div className={`health-indicator ${state?.ttsErpHealth?.healthy === false ? 'health-down' : 'health-up'}`}>
          <span className="health-dot" />
          <span>{state?.ttsErpHealth?.healthy === false ? 'tts-erp 离线' : 'tts-erp 在线'}</span>
        </div>
      </header>

      <section className="card">
        <div className="section-title"><h2>下游配置</h2><span className="caption">自动保存</span></div>
        <label>同步地址
          <input type="url" value={draft.syncBaseUrl} placeholder="https://example.com/tts"
            onChange={(event) => application.updateDraft({ ...draft, syncBaseUrl: event.target.value })} />
        </label>
        <label>访问令牌
          <input type="password" value={draft.syncToken} autoComplete="off" placeholder="Bearer token"
            onChange={(event) => application.updateDraft({ ...draft, syncToken: event.target.value })}
            onBlur={() => void application.saveSettingsNow('访问令牌已自动保存。')} />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={!draft.orderDomainSyncEnabled}
            onChange={(event) => application.updateDraft({ ...draft, orderDomainSyncEnabled: !event.target.checked })} />
          <span>暂停自动采集</span>
        </label>
      </section>

      <section className="card binding-card">
        <div className="section-title"><h2>Seller Center</h2><span className={state?.boundTab?.sellerId ? 'pill live' : 'pill'}>
          {state?.boundTab?.sellerId ? '已连接' : '未连接'}
        </span></div>
        <p className="description">订单插件会自动复用并固定可用的 Seller Center 页面，按接口分别读取订单、物流、结算、售后、订单详情和订单历史。</p>
        {state?.boundTab ? <dl><dt>Seller ID</dt><dd>{state.boundTab.sellerId ?? '等待页面请求捕获'}</dd></dl> : null}
        {automaticBinding ? <small className="caption binding-hint">正在搜索可用页面；本轮结束后仍会定时扫描。</small> : null}
        {!automaticBinding && automaticBindingTimedOut && !state?.boundTab?.sellerId
          ? <small className="caption binding-hint">暂未发现可用页面，插件会继续定时扫描。</small> : null}
      </section>

      <section className="card">
        <div className="section-title"><h2>同步进度</h2><span className="caption">本机保存断点</span></div>
        {state?.endpointCircuit ? <div className="critical-alert" role="alert">
          <strong>同步已暂停：TikTok 接口持续报错</strong>
          <span>{state.endpointCircuit.endpoint} · HTTP {state.endpointCircuit.httpStatus} · 连续 {state.endpointCircuit.consecutiveFailures} 次</span>
          <small>已停止继续请求和上传 TTS-ERP，请人工排查接口后取消暂停；配置会自动保存。</small>
        </div> : null}
        <div className="next-sync"><span>下次同步</span><strong>{formatNextSync(state)}</strong></div>
        <div className="sync-actions">
          <button disabled={busy || !readyToSync} onClick={() => void application.syncDomains(false)}>立即同步</button>
          <button className="secondary" disabled={busy || !state}
            onClick={exportLogs}>导出日志（{state?.runtimeLogs.length ?? 0}）</button>
          {hasFailures ? <button className="secondary" disabled={busy || !readyToSync}
            onClick={() => void application.syncDomains(true)}>重试失败项</button> : null}
        </div>
        <div className="domain-list">
          {DISPLAY_DOMAINS.map((domain) => {
            const row = state?.orderProgress.domains[domain];
            return <div className="domain-row" key={domain}>
              <strong>{DOMAIN_LABELS[domain]}</strong>
              <span>{row?.syncRunStatus === 'running' ? '同步中' : row?.lastSuccessAt ? `最近成功 ${formatTime(row.lastSuccessAt)}` : '等待同步'}</span>
              <em>{DOMAIN_DESCRIPTIONS[domain]}</em>
              <small>{domain === 'orders' ? `订单数 ${orderTotal(row)} · ` : ''}已上传 {row?.uploaded ?? 0} · 待处理 {row?.pending ?? 0} · 失败 {row?.failed ?? 0}</small>
              {row?.lastError ? <small className="error">{row.lastError}</small> : null}
              {domain !== 'after_sales' && row?.syncRunStatus === 'running'
                && Date.now() - Date.parse(row.lastProgressAt ?? '') > 2 * 60_000
                ? <button className="stop-button" disabled={busy}
                  onClick={() => void application.stopStuckDomain(domain, DOMAIN_LABELS[domain])}>
                  停止卡住任务并重试
                </button> : null}
            </div>;
          })}
        </div>
      </section>

      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <footer>数据由 Seller Center 页面会话读取；广告分析由独立插件处理。</footer>
    </main>
  );
}

async function send<T>(message: OrderExtensionMessage): Promise<T> {
  const reply = await chrome.runtime.sendMessage(message) as Reply<T>;
  if (!reply?.ok) throw new Error(reply?.error ?? '插件未返回结果。');
  return reply.data;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function formatNextSync(state: OrderSyncState | null): string {
  if (!state) return '加载中…';
  if (state.orderProgress.status === 'running') return '同步进行中';
  if (state.settings.syncPaused || !state.settings.orderDomainSyncEnabled) return '已暂停';
  const rows = DISPLAY_DOMAINS.map((domain) => state.orderProgress.domains[domain]);
  if (rows.some((row) => (row.pending ?? 0) > 0
    || (row.failed ?? 0) > 0
    || row.currentOrderId != null
    || row.resumeOrderId != null
    || row.syncRunStatus === 'interrupted')) return '等待续传';
  const nextSyncAt = rows
    .map((row) => row.nextSyncAt)
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  if (nextSyncAt) return formatTime(nextSyncAt);
  if (rows.some((row) => row.lastError != null || row.syncRunStatus === 'partial_failed')) return '等待重试';
  if (!state.boundTab?.sellerId || !state.settings.syncToken.trim()) return '等待配置';
  return '首次同步准备中';
}

function orderTotal(row: OrderSyncState['orderProgress']['domains']['orders'] | undefined): number {
  if (!row) return 0;
  return Math.max(0, row.serverTotal ?? row.total ?? 0);
}

createRoot(document.getElementById('root')!).render(<Popup />);
