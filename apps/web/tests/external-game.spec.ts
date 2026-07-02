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

async function attractScreenId(browser: Browser) {
  const tv = await desktopPage(browser);
  await tv.goto('/');
  await expect(tv.locator('.attract-shell')).toBeVisible();
  await expect(tv.getByRole('heading', { name: 'Local Couch' })).toBeVisible();
  await expect(tv.getByRole('heading', { name: 'Remote Couch' })).toBeVisible();
  await expect
    .poll(() => tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const screenId = await tv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));
  return { tv, screenId: screenId! };
}

test('EXTERNAL game: tap-race plays end-to-end on a couch', async ({ browser }) => {
  test.setTimeout(120_000);

  // TV: attract -> screenId.
  const { tv, screenId } = await attractScreenId(browser);

  // Phone Alex scans the Local QR -> auto-creates a room and claims this screen.
  const alex = await phonePage(browser, 'Alex');
  await alex.goto('/s/' + screenId + '?mode=local');
  await expect(alex).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = alex.url().split('/').pop()!;
  await expect(tv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible({ timeout: 15_000 });

  // Phone Bea joins via the invite link.
  const bea = await phonePage(browser, 'Bea');
  await bea.goto('/j/' + slug);
  await expect(bea).toHaveURL(new RegExp('/c/' + slug), { timeout: 15_000 });
  await expect(tv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });

  // Alex selects the Tap Race game card, then starts it.
  await alex.locator('.game-card', { hasText: 'Tap Race' }).click();
  const start = alex.getByRole('button', { name: /Tap Race starten/i });
  await expect(start).toBeEnabled();
  await start.click();

  // TV: the external game host stage mounts and the iframe handshakes (couch:ready).
  const stage = tv.locator('[data-testid="game-host-stage"]');
  await expect(stage).toBeVisible({ timeout: 20_000 });
  await expect(stage).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });

  const frame = tv.frameLocator('iframe[title="Tap Race"]');
  await expect(frame.locator('[data-testid^="lane-"]', { hasText: 'Alex' })).toBeVisible({ timeout: 20_000 });
  await expect(frame.locator('[data-testid^="lane-"]', { hasText: 'Bea' })).toBeVisible({ timeout: 20_000 });

  // Alex taps the generic TAP! button. The first 4 taps land well inside the
  // 'playing' state, so we can assert each increments the in-frame counter —
  // this proves the input relay (phone -> server -> host -> iframe) and the
  // fixture's own tap-counting logic both work end to end.
  const tapButton = alex.getByRole('button', { name: /TAP!/i });
  await expect(tapButton).toBeVisible();
  const aliceLaneCount = frame.locator('[data-testid^="count-"]').first();
  for (let i = 1; i <= 4; i += 1) {
    await tapButton.click();
    await expect(aliceLaneCount).toHaveText(String(i), { timeout: 10_000 });
  }

  // The 5th tap crosses the win threshold: the fixture sets the winner text
  // and calls couch.gameOver(). LobbyRoute keeps the stage mounted for a 5s
  // game-over linger (GAME_OVER_LINGER_MS) so the game's winner screen is
  // actually visible on the TV — assert it as a hard requirement.
  await tapButton.click();
  await expect(frame.locator('[data-testid="winner"]')).toContainText(/ALEX WINS!/i, { timeout: 4_000 });

  // Then gameOver's full round-trip completes: the linger elapses, the stage
  // is torn down, and the catalog (.game-card list) returns to .play-surface.
  await expect(tv.locator('[data-testid="game-host-stage"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(tv.locator('.play-surface .game-card', { hasText: 'Tap Race' })).toBeVisible({ timeout: 15_000 });

  await tv.close();
  await alex.close();
  await bea.close();
});
