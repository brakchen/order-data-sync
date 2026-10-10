# TK订单数据同步

Current version: `0.1.41`

独立 Chrome MV3 插件代码库，负责订单、物流和结算数据同步。

订单同步只调用 TTS-ERP `/v2/order-sync/*`，覆盖订单、物流和结算。插件有独立的 Manifest V3 后台、Seller Center 身份绑定与页面请求桥、Chrome storage、轮询调度和 Popup。首次运行需配置下游地址和令牌；Advertiser 可选。插件会自动复用已固定的 Seller Center 页面，否则选择并固定一个可用页面。没有可用页面时暂停同步并定时扫描，页面出现后自动恢复。订单数据及进度只存储在本扩展自己的 Chrome storage 中。

本仓库由父仓库 `chrome-plugins` 作为 Git submodule 引用；订单插件可独立安装、构建和发布。广告插件不负责启动它，也不共享运行状态或凭据。广告插件和订单插件通过 Seller Center 页面内的协调状态共享固定页面：页面有在途请求或近期已刷新时，另一插件会推迟刷新，避免中断请求或重复刷新。

## 开发

```powershell
npm install
npm test
npm run build
```

## 页面刷新

绑定页面达到两小时后才允许刷新。每次刷新前都会检查两个插件共享的页面请求租约、最近活动时间和刷新占用；页面正在被任一插件使用时延后五分钟再检查。两个插件同时到期时只有一个能取得刷新占用。
