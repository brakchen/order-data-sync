import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'TikTok Shop Order Data Sync',
    version: '0.1.21',
    description: '独立同步 TikTok Shop 订单、物流、结算与售后数据。',
    icons: {
      16: '/icons/icon-16.png',
      32: '/icons/icon-32.png',
      48: '/icons/icon-48.png',
      128: '/icons/icon-128.png',
    },
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
