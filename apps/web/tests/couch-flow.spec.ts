import { expect, test, type Browser } from '@playwright/test';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function desktopPage(browser: Browser) {
  return browser.newPage({
    viewport: { width: 1440, height: 960 },
    isMobile: false,
    hasTouch: false,
    userAgent: DESKTOP_UA
  });
}

async function phonePage(browser: Browser, name: string) {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await p.addInitScript((n) => window.localStorage.setItem('couch:name', n), name);
  return p;
}

// Pair a TV + a host phone via attract -> /s/:screenId -> "Create a room" -> auto-join.
async function pairHost(browser: Browser, hostName: string) {
  const tv = await desktopPage(browser);
  await tv.goto('/');
  await expect(tv.locator('.attract-shell')).toBeVisible();
  await expect
    .poll(() => tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const screenId = await tv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));

  const host = await phonePage(browser, hostName);
  await host.goto('/s/' + screenId);
  await host.getByRole('button', { name: /Create a room/i }).click();
  await expect(host).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = host.url().split('/').pop()!;

  // Claiming the scanned screen navigates the TV into the lobby (socket push + REST poll fallback).
  await expect(tv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });
  // The creator auto-joins as host (name from localStorage).
  await expect(tv.locator('.player-name', { hasText: hostName })).toBeVisible({ timeout: 15_000 });
  return { tv, host, slug };
}

test('standalone Trebuchet test route renders and fires a shot', async ({ page }) => {
  await page.goto('/games/trebuchet');
  await expect(page.getByText('/games/trebuchet')).toBeVisible();
  await expect(page.getByTestId('trebuchet-stage').locator('canvas')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Fire test shot/i }).click();
  await expect(page.getByText(/Alex|Bea|Winner|Finished/i).first()).toBeVisible({ timeout: 30_000 });
});

test('phone home shows the scan prompt with a create/join escape hatch', async ({ browser }) => {
  const phone = await phonePage(browser, 'Solo');
  await phone.goto('/');
  await expect(phone.getByText(/Scan a TV to begin/i)).toBeVisible();
  await expect(phone.getByRole('button', { name: /Create a room/i })).toBeVisible();
  await phone.close();
});

test('attract pairs a phone (Create a room), second joins via invite, chat + game start', async ({ browser }) => {
  test.setTimeout(90_000);
  const { tv, host, slug } = await pairHost(browser, 'Alex');

  // Second player opens the lobby invite /j/:slug and confirms.
  const bea = await phonePage(browser, 'Bea');
  await bea.goto('/j/' + slug);
  await bea.getByRole('button', { name: /^Join$/i }).click();
  await expect(bea).toHaveURL(new RegExp('/c/' + slug), { timeout: 15_000 });
  await expect(tv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });

  // Catalog overview on the TV.
  await expect(tv.locator('.game-catalog')).toBeVisible();
  await expect(tv.locator('.game-card-title', { hasText: 'Trebuchet' })).toBeVisible();

  // Chat round-trips controller -> TV.
  const chat = host.getByPlaceholder(/Message/i);
  await chat.fill('gg hello');
  await chat.press('Enter');
  await expect(tv.locator('.chat-msg-text', { hasText: 'gg hello' })).toBeVisible({ timeout: 10_000 });

  // Host selects Trebuchet and starts.
  await host.locator('.game-card', { hasText: 'Trebuchet' }).click();
  const start = host.getByRole('button', { name: /Trebuchet starten/i });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(tv.getByText('Live')).toBeVisible({ timeout: 10_000 });
  await expect(tv.getByTestId('trebuchet-stage')).toHaveAttribute('data-phase', 'running');

  await tv.close();
  await host.close();
  await bea.close();
});

test('controller survives a network drop and auto-rejoins (slept phone)', async ({ browser }) => {
  test.setTimeout(90_000);
  const { tv, host } = await pairHost(browser, 'Alex');

  const conn = tv.locator('.player-row', { hasText: 'Alex' }).locator('.connection');
  await expect(conn).toHaveText(/online/i, { timeout: 15_000 });

  await host.context().setOffline(true);
  await expect(conn).toHaveText(/reconnect/i, { timeout: 20_000 });

  await host.context().setOffline(false);
  await expect(conn).toHaveText(/online/i, { timeout: 20_000 });

  await tv.close();
  await host.close();
});
