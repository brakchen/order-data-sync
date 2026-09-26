# TikTok Shop Order Data Sync

独立 Chrome MV3 插件代码库，负责订单、物流和结算数据同步。该仓库通过 `ads-data-sync` 的 `order-data-sync/` Git submodule 在当前工作区开发。

订单同步只调用 TTS-ERP `/v2/order-sync/*`，覆盖订单、物流和结算。插件有独立的 Manifest V3 后台、Seller Center 身份绑定与页面请求桥、Chrome storage、轮询调度和 Popup。首次运行需配置下游地址和令牌，并绑定 Seller Center 页面；Advertiser 可选。订单数据及进度只存储在本扩展自己的 Chrome storage 中。

本仓库由 `ads-data-sync/order-data-sync/` 作为 Git submodule 引用；订单插件可独立安装、构建和发布。广告插件不负责启动它，也不共享运行状态或凭据。

## 开发

```powershell
npm install
npm test
npm run build
```

## 仓库初始化

GitHub 项目尚未创建。创建后，将父仓库 `.gitmodules` 中的占位 URL `https://github.com/REPLACE_ME/tiktok-shop-order-data-sync.git` 替换为实际地址，再将本仓库提交推送到 GitHub。当前本地实现与 submodule 记录不依赖 GitHub 在线仓库。
