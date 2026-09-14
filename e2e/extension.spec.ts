import { chromium, expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Manifest V3 side panel renders and overlay survives fullscreen movement and removal', async () => {
  const extensionPath = resolve('apps/extension/.output/chrome-mv3');
  const userDataDir = await mkdtemp(join(tmpdir(), 'marketsync-extension-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    let [serviceWorker] = context.serviceWorkers();
    serviceWorker ??= await context.waitForEvent('serviceworker');
    const extensionId = new URL(serviceWorker.url()).hostname;
    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect(sidePanel.getByRole('heading', { name: 'Harbor City wins' })).toBeVisible();
    await expect(sidePanel.getByText('Aligned to your broadcast')).toBeVisible();
    await expect(sidePanel.getByText('Live wire')).toBeVisible();
    const refreshFeed = sidePanel.getByRole('button', {
      name: 'Refresh live prices, game clock, and play-by-play',
    });
    await refreshFeed.click();
    await expect(refreshFeed).toContainText('Refreshed');

    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3000');
    await page.bringToFront();
    await sidePanel
      .getByRole('button', { name: 'Enable overlay on this site' })
      .evaluate((button) => {
        (button as HTMLButtonElement).click();
      });
    // A standalone extension document does not receive Chrome's activeTab
    // gesture grant like a real side panel opened from the toolbar. Assert the
    // explicit denial state, then exercise the statically permitted test host.
    await expect(sidePanel.getByText('Site access was not granted.')).toBeVisible();
    await page.addInitScript(() => {
      const activate = () =>
        document.documentElement?.setAttribute('data-marketsync-enable', 'true');
      activate();
      new MutationObserver(activate).observe(document, { childList: true });
    });
    await page.reload();
    const overlay = page.locator('#marketsync-overlay-host');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.title')).toContainText('Harbor City wins');
    const fullscreenSupported = await page.evaluate(() => document.fullscreenEnabled);
    if (fullscreenSupported) {
      await page.evaluate(() => document.documentElement.requestFullscreen());
      await expect(overlay).toBeVisible();
      await page.evaluate(() => document.exitFullscreen());
    }
    await overlay.locator('button.hide').click();
    await expect(overlay).toHaveCount(0);
  } finally {
    await context.close();
  }
});
