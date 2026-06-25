import { expect, test, type Page } from '@playwright/test';

async function holdAndReleaseFire(page: Page) {
  const fireButton = page.getByRole('button', { name: /Hold to charge and fire/i });
  await expect(fireButton).toBeEnabled({ timeout: 15_000 });
  const box = await fireButton.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.mouse.up();
}

test('standalone Trebuchet test route renders and fires a shot', async ({ page }) => {
  await page.goto('/games/trebuchet');
  await expect(page.getByText('/games/trebuchet')).toBeVisible();
  // Phaser canvas mount can lag under concurrent WebGL load — give it room.
  await expect(page.getByTestId('trebuchet-stage').locator('canvas')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Fire test shot/i }).click();
  await expect(page.getByText(/Alex|Bea|Winner|Finished/i).first()).toBeVisible({ timeout: 30_000 });
});

test('phone home only points to a shared screen', async ({ browser }) => {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto('/');
  await expect(phone.getByText(/Scan a TV to begin/i)).toBeVisible();
  await expect(phone.getByText(/Open couch\.gg on your TV, laptop, or shared screen/i)).toBeVisible();
  await expect(phone.getByRole('button', { name: /Create a room/i })).toHaveCount(0);
  await expect(phone.getByPlaceholder(/Room code/i)).toHaveCount(0);
  await phone.close();
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
  await expect(tv.getByRole('heading', { name: 'Local Couch' })).toBeVisible();
  await expect(tv.getByRole('heading', { name: 'Remote Couch' })).toBeVisible();
  // The QRs encode /s/:screenId with local/remote mode; the id is persisted once registration lands.
  await expect
    .poll(() => tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const screenId = await tv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));
  await tv.screenshot({ path: 'test-results/attract-home.png' });

  // 2) A laptop that opens the phone QR link is kept out of controller mode.
  const laptop = await browser.newPage({
    viewport: { width: 1280, height: 820 },
    isMobile: false,
    hasTouch: false,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await laptop.goto('/s/' + screenId + '?mode=local');
  await expect(laptop.getByText(/This link is for phones/i)).toBeVisible();
  await expect(laptop.getByRole('button', { name: /Create a room/i })).toHaveCount(0);
  await laptop.close();

  // 3) Phone scans Local Couch and auto-creates a room.
  const phoneOne = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  await phoneOne.addInitScript(() => window.localStorage.setItem('couch:name', 'Alex'));
  await phoneOne.goto('/s/' + screenId + '?mode=local');
  await expect(phoneOne).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = phoneOne.url().split('/').pop()!;

  // 4) Claiming the screen navigates the TV into that lobby (socket push, with REST poll fallback).
  await expect(tv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });

  // 5) The creator auto-joins as host.
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible();

  // 6) A second phone scans the lobby QR (/j/:slug) and auto-joins as controller.
  const phoneTwo = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  await phoneTwo.addInitScript(() => window.localStorage.setItem('couch:name', 'Bea'));
  await phoneTwo.goto('/j/' + slug);
  await expect(phoneTwo).toHaveURL(new RegExp('/c/' + slug), { timeout: 15_000 });

  // Both players appear on the TV.
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible();
  await expect(tv.locator('.player-name', { hasText: 'Bea' })).toBeVisible();

  // The TV shows the game catalog overview including Trebuchet.
  await expect(tv.locator('.game-catalog')).toBeVisible();
  await expect(tv.locator('.game-card-title', { hasText: 'Trebuchet' })).toBeVisible();
  await tv.screenshot({ path: 'test-results/lobby-tv.png' });

  // 7) Chat round-trips controller -> TV (read-only) and -> other controller, in the lobby state.
  const chatInput = phoneOne.getByPlaceholder(/Message/i);
  await chatInput.fill('gg hello');
  await chatInput.press('Enter');
  await expect(tv.locator('.chat-msg-text', { hasText: 'gg hello' })).toBeVisible({ timeout: 10_000 });
  await expect(phoneTwo.locator('.chat-msg-text', { hasText: 'gg hello' })).toBeVisible({ timeout: 10_000 });

  // 8) Host selects Trebuchet from the catalog (wires game:select) and starts the game.
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

test('remote couch pairs each player screen by room number', async ({ browser }) => {
  const hostTv = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    isMobile: false,
    hasTouch: false,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await hostTv.goto('/');
  await expect(hostTv.getByRole('heading', { name: 'Remote Couch' })).toBeVisible();
  await expect
    .poll(() => hostTv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const hostScreenId = await hostTv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));

  const hostPhone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await hostPhone.addInitScript(() => window.localStorage.setItem('couch:name', 'Alex'));
  await hostPhone.goto('/s/' + hostScreenId + '?mode=remote');
  await expect(hostPhone.getByRole('button', { name: /Host Game/i })).toBeVisible();
  await expect(hostPhone.getByRole('button', { name: /Join Game/i })).toBeVisible();
  await hostPhone.getByRole('button', { name: /Host Game/i }).click();
  await expect(hostPhone).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = hostPhone.url().split('/').pop()!;
  await expect(hostPhone.getByRole('dialog', { name: /Share Room Number/i })).toBeVisible({ timeout: 15_000 });
  await expect(hostPhone.getByLabel(/Remote room code/i)).toHaveText(slug);
  await expect(hostTv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });
  await expect(hostTv.locator('.player-name', { hasText: 'Alex' })).toBeVisible();
  await hostPhone.getByRole('button', { name: /Done/i }).click();

  const guestTv = await browser.newPage({
    viewport: { width: 1280, height: 820 },
    isMobile: false,
    hasTouch: false,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await guestTv.goto('/');
  await expect(guestTv.getByRole('heading', { name: 'Remote Couch' })).toBeVisible();
  await expect
    .poll(() => guestTv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const guestScreenId = await guestTv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));

  const guestPhone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await guestPhone.addInitScript(() => window.localStorage.setItem('couch:name', 'Bea'));
  await guestPhone.goto('/s/' + guestScreenId + '?mode=remote');
  await guestPhone.getByRole('button', { name: /Join Game/i }).click();
  await expect(guestPhone.getByLabel(/Room number/i)).toBeVisible();
  await guestPhone.getByLabel(/Room number/i).fill(slug);
  await guestPhone.getByRole('button', { name: /Join Game/i }).click();
  await expect(guestPhone).toHaveURL(new RegExp('/c/' + slug), { timeout: 15_000 });
  await expect(guestTv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });
  await expect(guestTv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });
  await expect(hostTv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });

  await hostPhone.locator('.game-card', { hasText: 'Trebuchet' }).click();
  const startBtn = hostPhone.getByRole('button', { name: /Trebuchet starten/i });
  await expect(startBtn).toBeEnabled();
  await startBtn.click();

  const hostStage = hostTv.getByTestId('trebuchet-stage');
  const guestStage = guestTv.getByTestId('trebuchet-stage');
  await expect(hostStage).toHaveAttribute('data-phase', 'running', { timeout: 20_000 });
  await expect(guestStage).toHaveAttribute('data-phase', 'running', { timeout: 20_000 });
  await expect(hostPhone.locator('.turn-state')).toBeVisible({ timeout: 20_000 });
  await expect(guestPhone.locator('.turn-state')).toBeVisible({ timeout: 20_000 });

  const beforeRevision = await hostStage.getAttribute('data-snapshot-rev');
  expect(beforeRevision).toBeTruthy();
  const hostTurnText = await hostPhone.locator('.turn-state').textContent();
  const activePhone = /YOUR TURN/i.test(hostTurnText ?? '') ? hostPhone : guestPhone;
  const otherPhone = activePhone === hostPhone ? guestPhone : hostPhone;

  await holdAndReleaseFire(activePhone);
  await expect(activePhone.locator('.last-shot')).toBeVisible({ timeout: 30_000 });
  await expect(otherPhone.locator('.last-shot')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => hostStage.getAttribute('data-snapshot-rev'), { timeout: 30_000 })
    .not.toBe(beforeRevision);
  const afterRevision = await hostStage.getAttribute('data-snapshot-rev');
  expect(afterRevision).toBeTruthy();
  await expect(guestStage).toHaveAttribute('data-snapshot-rev', afterRevision!, { timeout: 20_000 });

  await hostTv.close();
  await hostPhone.close();
  await guestTv.close();
  await guestPhone.close();
});

test('invite link opens the mobile controller automatically', async ({ browser }) => {
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
  await expect(host).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = host.url().split('/').pop()!;
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible();

  // A friend opens the invite link on a phone -> controller opens automatically.
  const friend = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await friend.addInitScript(() => window.localStorage.setItem('couch:name', 'Bea'));
  await friend.goto('/j/' + slug);
  await expect(friend).toHaveURL(new RegExp('/c/' + slug), { timeout: 15_000 });
  await expect(tv.locator('.player-name', { hasText: 'Bea' })).toBeVisible();

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
