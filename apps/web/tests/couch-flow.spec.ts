import { expect, test } from '@playwright/test';

test('standalone Trebuchet test route renders and fires a shot', async ({ page }) => {
  await page.goto('/games/trebuchet');
  await expect(page.getByText('/games/trebuchet')).toBeVisible();
  // Phaser canvas mount can lag under concurrent WebGL load — give it room.
  await expect(page.getByTestId('trebuchet-stage').locator('canvas')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Fire test shot/i }).click();
  await expect(page.getByText(/Alex|Bea|Winner|Finished/i).first()).toBeVisible({ timeout: 30_000 });
});

test('desktop attract pairs a phone, lobby chat + game start work', async ({ browser }) => {
  // 1) Desktop TV shows the retro attract screen and registers a short-lived screen id.
  const tv = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    isMobile: false,
    hasTouch: false,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await tv.goto('/');
  await expect(tv.locator('.attract-shell')).toBeVisible();
  // The QR encodes /s/:screenId; the id is persisted to sessionStorage once registration lands.
  await expect
    .poll(() => tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const screenId = await tv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));
  await tv.screenshot({ path: 'test-results/attract-home.png' });

  // 2) Phone "scans" the QR (opens /s/:screenId) and creates a room.
  const phoneOne = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  await phoneOne.addInitScript(() => window.localStorage.setItem('couch:name', 'Alex'));
  await phoneOne.goto('/s/' + screenId);
  await phoneOne.getByRole('button', { name: /Create a room/i }).click();
  await expect(phoneOne).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = phoneOne.url().split('/').pop()!;

  // 3) Claiming the screen navigates the TV into that lobby (socket push, with REST poll fallback).
  await expect(tv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });

  // 4) The creator auto-joins as host.
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible();

  // 5) A second phone auto-joins via the controller route.
  const phoneTwo = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  await phoneTwo.addInitScript(() => window.localStorage.setItem('couch:name', 'Bea'));
  await phoneTwo.goto('/c/' + slug);

  // Both players appear on the TV.
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible();
  await expect(tv.locator('.player-name', { hasText: 'Bea' })).toBeVisible();

  // The TV shows the game catalog overview including Trebuchet.
  await expect(tv.locator('.game-catalog')).toBeVisible();
  await expect(tv.locator('.game-card-title', { hasText: 'Trebuchet' })).toBeVisible();
  await tv.screenshot({ path: 'test-results/lobby-tv.png' });

  // 6) Chat round-trips controller -> TV (read-only) and -> other controller, in the lobby state.
  const chatInput = phoneOne.getByPlaceholder(/Message/i);
  await chatInput.fill('gg hello');
  await chatInput.press('Enter');
  await expect(tv.locator('.chat-msg-text', { hasText: 'gg hello' })).toBeVisible({ timeout: 10_000 });
  await expect(phoneTwo.locator('.chat-msg-text', { hasText: 'gg hello' })).toBeVisible({ timeout: 10_000 });

  // 7) Host selects Trebuchet from the catalog (wires game:select) and starts the game.
  await phoneOne.locator('.game-card', { hasText: 'Trebuchet' }).click();
  const startBtn = phoneOne.getByRole('button', { name: /Trebuchet starten/i });
  await expect(startBtn).toBeEnabled();
  await startBtn.click();

  // The TV goes live.
  await expect(tv.getByText('Live')).toBeVisible({ timeout: 10_000 });
  await expect(tv.getByTestId('trebuchet-stage')).toHaveAttribute('data-phase', 'running');
  await expect(phoneOne.getByText(/Your turn|Waiting/i)).toBeVisible();

  await tv.close();
  await phoneOne.close();
  await phoneTwo.close();
});

test('invite link opens the mobile join confirm', async ({ browser }) => {
  // Seed a lobby by creating one through a phone pairing flow against a fresh screen.
  const tv = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    isMobile: false,
    hasTouch: false,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await tv.goto('/');
  await expect
    .poll(() => tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const screenId = await tv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));

  const host = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await host.addInitScript(() => window.localStorage.setItem('couch:name', 'Alex'));
  await host.goto('/s/' + screenId);
  await host.getByRole('button', { name: /Create a room/i }).click();
  await expect(host).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = host.url().split('/').pop()!;
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible();

  // A friend opens the invite link on a phone -> mobile join confirm (never the desktop home).
  const friend = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await friend.goto('/j/' + slug);
  await expect(friend.locator('.join-confirm-card')).toBeVisible();
  await expect(friend.getByText(/Join this room\?/i)).toBeVisible();
  await friend.getByRole('button', { name: /^Join$/i }).click();
  await expect(friend).toHaveURL(new RegExp('/c/' + slug));

  await tv.close();
  await host.close();
  await friend.close();
});

test('controller survives a network drop and auto-rejoins (slept phone)', async ({ browser }) => {
  test.setTimeout(90_000);
  const tv = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    isMobile: false,
    hasTouch: false,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await tv.goto('/');
  await expect
    .poll(() => tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const screenId = await tv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));

  const host = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await host.addInitScript(() => window.localStorage.setItem('couch:name', 'Alex'));
  await host.goto('/s/' + screenId);
  await host.getByRole('button', { name: /Create a room/i }).click();
  await expect(host).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = host.url().split('/').pop()!;

  const alexConnection = tv.locator('.player-row', { hasText: 'Alex' }).locator('.connection');
  await expect(alexConnection).toHaveText(/online/i, { timeout: 15_000 });

  // Phone goes to sleep / loses network — the socket drops.
  await host.context().setOffline(true);
  await expect(host.locator('.reconnect-pill')).toBeVisible({ timeout: 20_000 });
  await expect(alexConnection).toHaveText(/reconnect/i, { timeout: 20_000 });

  // Phone wakes — the controller auto-rejoins with no manual action, within the grace window.
  await host.context().setOffline(false);
  await expect(host.locator('.reconnect-pill')).toBeHidden({ timeout: 20_000 });
  await expect(alexConnection).toHaveText(/online/i, { timeout: 20_000 });

  // And it is fully functional again: a chat from the phone reaches the TV.
  await host.getByPlaceholder(/Message/i).fill('back online');
  await host.getByPlaceholder(/Message/i).press('Enter');
  await expect(tv.locator('.chat-msg-text', { hasText: 'back online' })).toBeVisible({ timeout: 10_000 });

  await tv.close();
  await host.close();
});
