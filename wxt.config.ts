import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'TikTok Shop Order Data Sync',
    version: '0.1.0',
    description: '独立同步 TikTok Shop 订单、物流与结算数据。',
    permissions: ['alarms', 'storage', 'tabs', 'scripting', 'unlimitedStorage'],
    host_permissions: [
      'https://seller.tiktokglobalshop.com/*',
      'https://seller.tiktokshopglobalselling.com/*',
      'https://api16-normal-sg.tiktokshopglobalselling.com/*',
      'https://daqiang.nat100.top/*',
      'http://daqiang.nat100.top/*',
    ],
  },
  modules: ['@wxt-dev/module-react'],
});
