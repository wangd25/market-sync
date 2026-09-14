import React from 'react';
import { createRoot } from 'react-dom/client';
import { MarketSyncDashboard } from '@marketsync/ui';
import type { MarketSyncPublicSnapshot, VideoTimelineEvent } from '@marketsync/ui';
import '@marketsync/ui/theme.css';

const POLYMARKET_ORIGINS = [
  'https://gamma-api.polymarket.com/*',
  'https://clob.polymarket.com/*',
  'https://ws-subscriptions-clob.polymarket.com/*',
  'https://sports-api.polymarket.com/*',
  'https://site.api.espn.com/*',
];

let pendingSnapshot: MarketSyncPublicSnapshot | undefined;
let snapshotTimer: number | undefined;
const publishSnapshot = (snapshot: MarketSyncPublicSnapshot) => {
  pendingSnapshot = snapshot;
  if (snapshotTimer !== undefined) return;
  snapshotTimer = window.setTimeout(() => {
    snapshotTimer = undefined;
    if (pendingSnapshot !== undefined)
      void browser.storage.local.set({ 'marketsync:public-snapshot': pendingSnapshot });
  }, 500);
};

const requestLiveAccess = async () => {
  if (await browser.permissions.contains({ origins: POLYMARKET_ORIGINS })) return true;
  return browser.permissions.request({ origins: POLYMARKET_ORIGINS });
};

const subscribeVideoEvents = (listener: (event: VideoTimelineEvent) => void) => {
  const handler = (message: unknown) => {
    const candidate = message as { type?: string; event?: VideoTimelineEvent };
    if (candidate.type === 'MARKETSYNC_VIDEO_EVENT' && candidate.event !== undefined)
      listener(candidate.event);
  };
  browser.runtime.onMessage.addListener(handler);
  return () => browser.runtime.onMessage.removeListener(handler);
};

const enableOverlayForActiveSite = async (): Promise<'enabled' | 'denied' | 'unavailable'> => {
  // `activeTab` may intentionally redact the URL from tabs.query. Validate the
  // protocol inside the selected page instead of requiring broad tabs access.
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) return 'unavailable';
  try {
    const [protocol] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => /^https?:$/.test(location.protocol),
    });
    if (protocol?.result !== true) return 'unavailable';
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.setAttribute('data-marketsync-enable', 'true'),
    });
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['/content-scripts/content.js'],
    });
    return 'enabled';
  } catch {
    return 'denied';
  }
};

const root = document.querySelector('#root');
if (root === null) throw new Error('MarketSync side-panel root is missing');
createRoot(root).render(
  <React.StrictMode>
    <MarketSyncDashboard
      compact
      requestLiveAccess={requestLiveAccess}
      onPublicSnapshot={publishSnapshot}
      subscribeVideoEvents={subscribeVideoEvents}
      enableOverlayForActiveSite={enableOverlayForActiveSite}
    />
  </React.StrictMode>,
);
