# TikTok Shop Order Data Sync

独立 Chrome MV3 插件代码库，负责订单、物流和结算数据同步。该仓库通过 `ads-data-sync` 的 `order-data-sync/` Git submodule 在当前工作区开发。

## 模块来源

`src/core/` 已迁入当前插件中的订单域 API 契约和纯逻辑模块，`tests/` 已复制对应回归用例。浏览器运行时（独立 storage、身份绑定、轮询调度及订单 Popup）仍需从旧插件迁入后，本插件才可独立投入使用；迁移期间请勿发布本仓库作为完整插件。

订单同步只调用 TTS-ERP `/v2/order-sync/*`，覆盖订单、物流和结算。首次运行需配置下游地址和令牌，并从 Seller Center 页面捕获 Seller 身份；Advertiser 可选。订单数据及进度存储在本扩展独立的 Chrome storage 中。

## 开发

```powershell
npm install
npm test
npm run build
```

## 仓库初始化

GitHub 项目尚未创建。创建后，将 `ads-data-sync/.gitmodules` 中的 `https://github.com/REPLACE_ME/tiktok-shop-order-data-sync.git` 替换成实际地址，并推送本仓库的 `order-data-sync/` 初始提交。
