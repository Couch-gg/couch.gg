import { expect, test, type APIRequestContext, type Browser, type Page, type Route } from '@playwright/test';

// How TVs and phones keep their lobby in step: an older snapshot never
// replaces a newer one.

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REALTIME_URL = 'http://127.0.0.1:4100';

function desktopPage(browser: Browser) {
  return browser.newPage({ viewport: { width: 1440, height: 960 }, isMobile: false, hasTouch: false, userAgent: DESKTOP_UA });
}

async function phonePage(browser: Browser, name: string) {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await p.addInitScript((n) => window.localStorage.setItem('couch:name', n), name);
  return p;
}

async function newLobby(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${REALTIME_URL}/api/lobbies`, { data: {} });
  return (await res.json()).lobby.slug;
}

async function joinByLink(page: Page, slug: string) {
  await page.goto('/j/' + slug);
  await expect(page).toHaveURL(new RegExp('/c/' + slug), { timeout: 15_000 });
  await expect(page.locator('.name-edit-trigger')).toBeVisible({ timeout: 15_000 });
}

const isPoll = (slug: string) => (url: URL) => url.pathname === `/api/lobbies/${slug}`;

// Hold the answer to the page's next lobby poll: the server answers it now,
// the page gets it only on release().
async function holdNextPoll(page: Page, slug: string) {
  let armed = false;
  let captured: () => void = () => {};
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(isPoll(slug), async (route: Route) => {
    if (!armed) return route.continue();
    armed = false;
    const response = await route.fetch();
    captured();
    await released;
    await route.fulfill({ response });
  });
  return {
    // Resolves once a poll's answer is held.
    arm: () =>
      new Promise<void>((resolve) => {
        captured = resolve;
        armed = true;
      }),
    release
  };
}

test('a poll answered before the round started does not take it back on the TV or a phone', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const slug = await newLobby(request);
  const tv = await desktopPage(browser);
  const tvPoll = await holdNextPoll(tv, slug);
  await tv.goto('/l/' + slug);
  const alex = await phonePage(browser, 'Alex');
  const alexPoll = await holdNextPoll(alex, slug);
  await joinByLink(alex, slug);
  const bea = await phonePage(browser, 'Bea');
  await joinByLink(bea, slug);
  await expect(tv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });
  await alex
    .locator('.game-card')
    .filter({ has: alex.locator('.game-card-title', { hasText: /^Tap Race$/ }) })
    .click();
  const start = alex.getByRole('button', { name: /Tap Race starten/i });
  await expect(start).toBeEnabled();

  // Both pages have a poll answered with the lobby still waiting.
  await Promise.all([tvPoll.arm(), alexPoll.arm()]);
  await start.click();
  const stage = tv.locator('[data-testid="game-host-stage"]');
  await expect(stage).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  const tap = alex.getByRole('button', { name: /TAP!/i });
  await expect(tap).toBeVisible({ timeout: 10_000 });

  // Mark the running game, and watch the phone for the lobby view.
  await tv.locator('iframe[title="Tap Race"]').evaluate((frame) => frame.setAttribute('data-mark', 'running'));
  await alex.evaluate(() => {
    const seen = { lobbyView: false };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    new MutationObserver(() => {
      if (document.querySelector('.game-card')) seen.lobbyView = true;
    }).observe(document.body, { childList: true, subtree: true });
  });

  tvPoll.release();
  alexPoll.release();
  // Give the old answers (and a few regular polls after them) time to land.
  await tv.waitForTimeout(2_000);

  // Same game, never torn down; the phone never went back to the lobby view.
  await expect(tv.locator('iframe[title="Tap Race"][data-mark="running"]')).toHaveCount(1);
  expect(await alex.evaluate(() => (window as unknown as { __seen: { lobbyView: boolean } }).__seen.lobbyView)).toBe(false);
  await tap.click();
  await expect(tv.frameLocator('iframe[title="Tap Race"]').locator('[data-testid^="count-"]').first()).toHaveText('1', {
    timeout: 10_000
  });

  await tv.close();
  await alex.close();
  await bea.close();
});
