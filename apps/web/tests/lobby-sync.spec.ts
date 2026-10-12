import { expect, test, type APIRequestContext, type Browser, type Page, type Route } from '@playwright/test';

// How TVs and phones keep their lobby in step: an older snapshot never
// replaces a newer one, and the poll slows down while the socket carries
// every change.

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

// Count the page's lobby polls.
function countPolls(page: Page, slug: string) {
  const at: number[] = [];
  page.on('request', (req) => {
    if (isPoll(slug)(new URL(req.url()))) at.push(Date.now());
  });
  return { since: (t: number) => at.filter((x) => x >= t).length };
}

// Pass the page's socket through, telling it the server's room emits reach
// every instance ('redis' fan-out) while `redis.on` is set. Join acks are
// Socket.IO ack packets ("43<id>[{...}]") that carry a `fanout` field.
async function reportFanout(page: Page) {
  const redis = { on: true };
  const sockets: Array<{ close: () => Promise<void> }> = [];
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    sockets.push({ close: () => ws.close() });
    server.onMessage((message) => {
      const match = typeof message === 'string' ? /^43(\d+)(\[.*)$/s.exec(message) : null;
      if (match && redis.on) {
        const args = JSON.parse(match[2]);
        if (args[0] && typeof args[0] === 'object' && 'fanout' in args[0]) {
          args[0].fanout = 'redis';
          ws.send(`43${match[1]}${JSON.stringify(args)}`);
          return;
        }
      }
      ws.send(message);
    });
  });
  return { redis, dropSockets: () => Promise.all(sockets.splice(0).map((s) => s.close())) };
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

test('the lobby poll slows down while the socket carries every change, and speeds up without it', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const slug = await newLobby(request);
  const tv = await desktopPage(browser);
  const tvSocket = await reportFanout(tv);
  const tvPolls = countPolls(tv, slug);
  await tv.goto('/l/' + slug);
  const alex = await phonePage(browser, 'Alex');
  const alexSocket = await reportFanout(alex);
  const alexPolls = countPolls(alex, slug);
  await joinByLink(alex, slug);
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible({ timeout: 15_000 });

  // Both joined with 'redis' fan-out: about one poll per 5 s each.
  await tv.waitForTimeout(1_000);
  let from = Date.now();
  await tv.waitForTimeout(6_000);
  expect(tvPolls.since(from)).toBeGreaterThanOrEqual(1);
  expect(tvPolls.since(from)).toBeLessThanOrEqual(2);
  expect(alexPolls.since(from)).toBeGreaterThanOrEqual(1);
  expect(alexPolls.since(from)).toBeLessThanOrEqual(2);
  // Changes still arrive at once, over the socket.
  await alex.locator('.name-edit-trigger').click();
  await alex.locator('.name-edit-form input').fill('Alexa');
  await alex.locator('.name-edit-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(tv.locator('.player-name', { hasText: 'Alexa' })).toBeVisible({ timeout: 2_000 });

  // The connection drops, and the server they get back to only reaches its
  // own instance's sockets: every 750 ms again.
  tvSocket.redis.on = false;
  alexSocket.redis.on = false;
  await Promise.all([tvSocket.dropSockets(), alexSocket.dropSockets()]);
  await tv.waitForTimeout(1_500);
  from = Date.now();
  await tv.waitForTimeout(3_000);
  expect(tvPolls.since(from)).toBeGreaterThanOrEqual(3);
  expect(alexPolls.since(from)).toBeGreaterThanOrEqual(3);

  await tv.close();
  await alex.close();
});

test('a lobby that a deploy from before revs stored last still reaches a TV that holds a rev', async ({ browser, request }) => {
  test.setTimeout(60_000);
  const slug = await newLobby(request);
  const tv = await desktopPage(browser);
  await tv.goto('/l/' + slug);
  const alex = await phonePage(browser, 'Alex');
  await joinByLink(alex, slug);
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible({ timeout: 15_000 });

  // From now on the TV's polls are answered the way such a lobby is: without
  // a rev, and with a change made by the old deploy.
  await tv.route(isPoll(slug), async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json();
    expect(typeof body.lobby.rev).toBe('number');
    const { rev: _rev, ...lobby } = body.lobby;
    lobby.players = lobby.players.map((p: { name: string }) => ({ ...p, name: `${p.name} (old deploy)` }));
    await route.fulfill({ response, json: { lobby } });
  });
  await expect(tv.locator('.player-name', { hasText: 'Alex (old deploy)' })).toBeVisible({ timeout: 5_000 });

  await tv.close();
  await alex.close();
});
