import { expect, test } from '@playwright/test';

test('fixture stream supports manual synchronization, pause, and strict freeze', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.ms-app')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByRole('heading', { name: 'Harbor City wins' })).toBeVisible();
  await expect(page.getByText('Aligned to your broadcast')).toBeVisible();

  const delay = page.getByRole('slider', { name: 'Viewer delay' }).first();
  await delay.fill('25');
  await expect(page.getByRole('status').filter({ hasText: 'Updating timeline' })).toBeVisible();
  await delay.fill('20');
  await expect(page.getByText('20.0s', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Broadcast updates' })).toBeVisible();

  await page.getByRole('button', { name: 'Pause chart' }).click();
  await expect(page.getByRole('button', { name: 'Resume chart' })).toBeVisible();

  await page.getByText('Demo and companion tools').click();
  await page.getByRole('button', { name: 'Low confidence' }).click();
  await expect(page.getByText('Frozen for safety')).toBeVisible();
  await expect(page.getByText('All market fields held at the last safe projection')).toBeVisible();
});

test('delayed game updates can be used as a one-tap synchronization anchor', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ms-app')).toHaveAttribute('data-hydrated', 'true');
  await page.getByRole('button', { name: /Metro Owls win/ }).click();
  await expect(page.getByText('Opponent possession', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Sync when seen' }).click();
  await expect(page.getByText(/Matched “Opponent possession”/)).toBeVisible();
});

test('pulse view pairs two win probabilities with momentum and the latest delayed play', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.ms-app')).toHaveAttribute('data-hydrated', 'true');
  await page.getByRole('button', { name: /Metro Owls win/ }).click();
  await page.getByRole('slider', { name: 'Viewer delay' }).first().fill('9');
  await page.getByRole('button', { name: 'Pulse' }).click();

  await expect(page.getByText('Hugo Gonzalez slams an emphatic dunk').first()).toBeVisible();
  await expect(page.getByText('Latest on your broadcast')).toBeVisible();
  await expect(page.getByText('Big move').first()).toBeVisible();
  await expect(page.locator('.ms-market-panel.pulse-mode .ms-animated-price')).toHaveCount(2);
});

test('the reproduced Polymarket MLB event URL resolves contracts and activates delayed history', async ({
  page,
}) => {
  const historyTimestamp = Math.floor(Date.now() / 1_000) - 60;
  await page.route(
    'https://gamma-api.polymarket.com/events/slug/mlb-pit-cle-2026-07-17',
    async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'mlb-event',
          slug: 'mlb-pit-cle-2026-07-17',
          title: 'Pittsburgh Pirates vs. Cleveland Guardians',
          live: true,
          ended: false,
          score: '3-2',
          period: 'Top 7',
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
          gameId: 'mlb-game',
          markets: [
            {
              id: 'moneyline',
              question: 'Pittsburgh Pirates vs. Cleveland Guardians',
              slug: 'mlb-pit-cle-2026-07-17',
              conditionId: 'moneyline-condition',
              clobTokenIds: '["pit-yes","pit-no"]',
              outcomes: '["Pirates","Guardians"]',
              active: true,
              closed: false,
            },
            {
              id: 'total',
              question: 'Game total over 8.5',
              slug: 'mlb-pit-cle-2026-07-17-total',
              conditionId: 'total-condition',
              clobTokenIds: '["over","under"]',
              outcomes: '["Over","Under"]',
              active: true,
              closed: false,
            },
          ],
        }),
      });
    },
  );
  await page.route('https://clob.polymarket.com/prices-history?**', async (route) => {
    const isNoAsset = new URL(route.request().url()).searchParams.get('market') === 'pit-no';
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ history: [{ t: historyTimestamp, p: isNoAsset ? 0.39 : 0.61 }] }),
    });
  });
  await page.routeWebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market', () => {});
  await page.routeWebSocket('wss://sports-api.polymarket.com/ws', () => {});

  await page.goto('/');
  await page.getByRole('button', { name: 'Polymarket Live' }).click();
  await page
    .getByLabel('Live market URL or ID')
    .fill('https://polymarket.com/event/mlb-pit-cle-2026-07-17#Iyh123E');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(
    page.getByText('Found 2 contracts. Choose the one you want to follow.'),
  ).toBeVisible();
  await page
    .getByLabel('Contract')
    .selectOption({ label: 'Pittsburgh Pirates vs. Cleveland Guardians' });
  await expect(
    page.getByRole('heading', { name: 'Pittsburgh Pirates vs. Cleveland Guardians' }),
  ).toBeVisible();
  await expect(page.getByText('61¢', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('39¢', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Top 7', { exact: true })).toBeVisible();
});

test('baseball calibrates from a unique run instead of a game clock', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ms-app')).toHaveAttribute('data-hydrated', 'true');
  await page.getByRole('button', { name: /Harbor Hawks win/ }).click();
  await expect(page.getByText('Top 8', { exact: true })).toBeVisible();
  await page.getByLabel('Baseball moment').selectOption('run');
  await page.getByLabel('Baseball inning').fill('8');
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await page.getByLabel('Home score').fill('3');
  await page.getByLabel('Opponent score').fill('4');
  await page.getByRole('button', { name: '2', exact: true }).click();
  await page.getByLabel('Baseball count').selectOption('0-0');
  await page.getByRole('button', { name: 'Use this play' }).click();
  await expect(page.getByText(/Unique play matched\. Delay set to 2\d\.\d+s\./)).toBeVisible();
});

test('two companion clients pair through a local room without sharing delay', async ({
  browser,
}) => {
  const first = await browser.newPage();
  const second = await browser.newPage();
  await Promise.all([first.goto('/'), second.goto('/')]);
  await Promise.all([
    expect(first.locator('.ms-app')).toHaveAttribute('data-hydrated', 'true'),
    expect(second.locator('.ms-app')).toHaveAttribute('data-hydrated', 'true'),
  ]);
  await Promise.all([
    first.getByText('Demo and companion tools').click(),
    second.getByText('Demo and companion tools').click(),
  ]);
  await first.getByRole('button', { name: 'Create' }).click();
  await expect(first.getByText(/Room created/)).toBeVisible();
  const code = await first.getByLabel('Room code').inputValue();
  expect(code).toHaveLength(6);
  await second.getByLabel('Room code').fill(code);
  await second.getByRole('button', { name: 'Join' }).click();
  await expect(second.getByText(/Paired/)).toBeVisible();
  await second.getByRole('slider', { name: 'Viewer delay' }).first().fill('7');
  await expect(first.getByRole('slider', { name: 'Viewer delay' }).first()).toHaveValue('20');
  await expect(second.getByRole('slider', { name: 'Viewer delay' }).first()).toHaveValue('7');
});

test('responsive companion remains usable on a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.ms-app')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByRole('heading', { name: 'Harbor City wins' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Pause chart/ })).toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
});

test('mouse wheel zooms the delayed chart and reset restores fit-to-content', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ms-app')).toHaveAttribute('data-hydrated', 'true');
  const chart = page.locator('.ms-chart');
  await expect(chart).toBeVisible();
  const chartBox = await chart.boundingBox();
  expect(chartBox).not.toBeNull();
  if (chartBox === null) return;

  const pageScrollBefore = await page.evaluate(() => window.scrollY);
  await page.mouse.move(chartBox.x + chartBox.width / 2, chartBox.y + chartBox.height / 2);
  await page.mouse.wheel(0, -500);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore);
  await expect(page.locator('.ms-chart-wrap')).toHaveAttribute('data-chart-zoom', 'custom');
  const reset = page.getByRole('button', { name: 'Reset zoom' });
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(page.locator('.ms-chart-wrap')).toHaveAttribute('data-chart-zoom', 'fit');
  await expect(reset).toBeDisabled();
});

test('sync modes, source provenance, and sanitized research diagnostics are visible', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.ms-app')).toHaveAttribute('data-hydrated', 'true');

  const modes = page.getByRole('group', { name: 'Synchronization mode' });
  await expect(modes.getByRole('button', { name: 'Auto sync' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await modes.getByRole('button', { name: 'Confirm plays' }).click();
  await expect(modes.getByRole('button', { name: 'Confirm plays' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await modes.getByRole('button', { name: 'Manual' }).click();
  await expect(modes.getByRole('button', { name: 'Manual' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await expect(page.locator('.ms-app')).toHaveAttribute('data-hydrated', 'true');
  await expect(
    page
      .getByRole('group', { name: 'Synchronization mode' })
      .getByRole('button', { name: 'Manual' }),
  ).toHaveAttribute('aria-pressed', 'true');

  await expect(page.getByText('Deterministic demo feed').first()).toBeVisible();
  await page.getByText('Connection quality').click();
  await expect(page.getByText('Sports source')).toBeVisible();
  await expect(page.getByText('Source quality')).toBeVisible();

  await page.getByText('Research session').click();
  await expect(page.getByText('Sports provider p50')).toBeVisible();
  await expect(page.getByText('Viewer delay p50')).toBeVisible();
  await expect(page.getByText('Approximate timestamps')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export sanitized JSONL' })).toBeEnabled();
});
