import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'MarketSync',
    description: 'Align prediction-market information to your delayed broadcast timeline.',
    version: '0.1.0',
    permissions: ['activeTab', 'sidePanel', 'storage', 'scripting'],
    optional_host_permissions: [
      'https://gamma-api.polymarket.com/*',
      'https://clob.polymarket.com/*',
      'https://ws-subscriptions-clob.polymarket.com/*',
      'https://sports-api.polymarket.com/*',
      'https://site.api.espn.com/*',
    ],
    action: { default_title: 'Open MarketSync' },
    side_panel: { default_path: 'sidepanel.html' },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
