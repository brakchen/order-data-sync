import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createDefaultOrderSettings } from '../../src/core/settings';
import type { OrderExtensionMessage } from '../../src/extension/messages';
import type { OrderDomainKey, OrderSyncSettings, OrderSyncState } from '../../src/core/types';
import './style.css';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
const DOMAIN_LABELS: Record<OrderDomainKey, string> = {
  orders: '订单', logistics: '物流', statements: '结算',
  order_details: '订单详情', order_history: '订单历史',
};

function Popup() {
  const [state, setState] = useState<OrderSyncState | null>(null);
  const [draft, setDraft] = useState<OrderSyncSettings>(createDefaultOrderSettings());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = async (updateDraft = false) => {
    try {
      const result = await send<OrderSyncState>({ type: 'order-sync:get-state' });
      setState(result);
      if (updateDraft) setDraft(result.settings);
    } catch (error) {
      setNotice(toMessage(error));
    }
  };

  useEffect(() => {
    void refresh(true);
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.orderSyncState) void refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);

  const run = async (
    action: () => Promise<OrderSyncState>,
    success: string,
    updateDraft = false,
  ) => {
    setBusy(true);
    setNotice('');
    try {
      const next = await action();
      setState(next);
      if (updateDraft) setDraft(next.settings);
      setNotice(success);
    } catch (error) {
      setNotice(toMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(
    () => send<OrderSyncState>({ type: 'order-sync:save-settings', settings: draft }),
    '配置已保存。',
    true,
  );
  const toggleBinding = () => state?.boundTab
    ? run(() => send<OrderSyncState>({ type: 'order-sync:unbind-tab' }), '已解绑 Seller Center 页面。')
    : run(() => send<OrderSyncState>({ type: 'order-sync:bind-tab' }), '已绑定页面，请等待 Seller 身份捕获。');
  const sync = (retryFailedOnly: boolean) => run(
    () => send<OrderSyncState>({ type: 'order-sync:sync-domains', retryFailedOnly }),
    retryFailedOnly ? '失败项已加入同步队列。' : '订单、物流和结算同步已启动。',
  );
  const readyToSync = Boolean(state?.boundTab?.sellerId && state.settings.syncToken.trim()
    && state.settings.orderDomainSyncEnabled && !state.settings.syncPaused);
  const hasFailures = (['orders', 'logistics', 'statements'] as const).some((domain) => {
    const row = state?.orderProgress.domains[domain];
    return Boolean(row && (row.lastError || row.pending > 0 || (row.failed ?? 0) > 0
      || row.syncRunStatus === 'partial_failed' || row.syncRunStatus === 'interrupted'));
  });

  return (
    <main className="shell">
      <header className="header">
        <div className="mark">OS</div>
        <div><p className="eyebrow">TIKTOK SHOP</p><h1>订单数据同步</h1></div>
      </header>

      <section className="card">
        <h2>下游配置</h2>
        <label>同步地址
          <input type="url" value={draft.syncBaseUrl} placeholder="https://example.com/tts"
            onChange={(event) => setDraft({ ...draft, syncBaseUrl: event.target.value })} />
        </label>
        <label>访问令牌
          <input type="password" value={draft.syncToken} autoComplete="off" placeholder="Bearer token"
            onChange={(event) => setDraft({ ...draft, syncToken: event.target.value })} />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={!draft.orderDomainSyncEnabled}
            onChange={(event) => setDraft({ ...draft, orderDomainSyncEnabled: !event.target.checked })} />
          <span>暂停自动采集</span>
        </label>
        <button className="secondary" disabled={busy} onClick={() => void save()}>保存配置</button>
      </section>

      <section className="card binding-card">
        <div className="section-title"><h2>Seller Center</h2><span className={state?.boundTab?.sellerId ? 'pill live' : 'pill'}>
          {state?.boundTab?.sellerId ? '已连接' : '未连接'}
        </span></div>
        <p className="description">订单插件使用当前登录页面会话读取订单、物流和结算数据。</p>
        {state?.boundTab ? <dl><dt>Seller ID</dt><dd>{state.boundTab.sellerId ?? '等待页面请求捕获'}</dd></dl> : null}
        <button disabled={busy} onClick={() => void toggleBinding()}>
          {busy ? '处理中…' : state?.boundTab ? '解除页面绑定' : '绑定当前 Seller Center 页面'}
        </button>
      </section>

      <section className="card">
        <div className="section-title"><h2>同步进度</h2><span className="caption">本机保存断点</span></div>
        <div className="sync-actions">
          <button disabled={busy || !readyToSync} onClick={() => void sync(false)}>立即同步</button>
          {hasFailures ? <button className="secondary" disabled={busy || !readyToSync}
            onClick={() => void sync(true)}>重试失败项</button> : null}
        </div>
        <div className="domain-list">
          {(['orders', 'logistics', 'statements'] as const).map((domain) => {
            const row = state?.orderProgress.domains[domain];
            return <div className="domain-row" key={domain}>
              <strong>{DOMAIN_LABELS[domain]}</strong>
              <span>{row?.syncRunStatus === 'running' ? '同步中' : row?.lastSuccessAt ? `最近成功 ${formatTime(row.lastSuccessAt)}` : '等待同步'}</span>
              <small>已上传 {row?.uploaded ?? 0} · 待处理 {row?.pending ?? 0} · 失败 {row?.failed ?? 0}</small>
              {row?.lastError ? <small className="error">{row.lastError}</small> : null}
              {row?.syncRunStatus === 'running' && Date.now() - Date.parse(row.lastProgressAt ?? '') > 2 * 60_000
                ? <button className="stop-button" disabled={busy} onClick={() => void run(
                  () => send<OrderSyncState>({ type: 'order-sync:stop-stuck-domain', domain }),
                  `${DOMAIN_LABELS[domain]}任务已停止并从断点重试。`,
                )}>停止卡住任务并重试</button> : null}
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

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败。';
}

createRoot(document.getElementById('root')!).render(<Popup />);
