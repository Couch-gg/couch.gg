import { expect, test, type APIRequestContext, type Browser, type Page, type WebSocketRoute } from '@playwright/test';

// Phones and the attract screen across leaving, lost seats, solo starts,
// slow first connections and expired screen ids.

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

async function lobbyOf(request: APIRequestContext, slug: string) {
  const res = await request.get(`${REALTIME_URL}/api/lobbies/${slug}`);
  return (await res.json()).lobby as { players: Array<{ id: string; name: string }>; hostPlayerId: string | null; state: string };
}

async function joinByLink(page: Page, slug: string) {
  await page.goto('/j/' + slug);
  await expect(page).toHaveURL(new RegExp('/c/' + slug), { timeout: 15_000 });
  await expect(page.locator('.name-edit-trigger')).toBeVisible({ timeout: 15_000 });
}

// Hold everything the server sends until 8.8 s after the page opened its
// first socket, so the first connection only goes through after the 8 s join
// timeout. Every socket opened in that window waits: in development React
// mounts each page twice, and the first socket is thrown away at once.
async function slowFirstConnection(page: Page) {
  let releaseAt = 0;
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    if (!releaseAt) releaseAt = Date.now() + 8_800;
    const wait = releaseAt - Date.now();
    if (wait <= 0) return;
    const held: Array<string | Buffer> = [];
    let holding = true;
    server.onMessage((message) => (holding ? held.push(message) : ws.send(message)));
    setTimeout(() => {
      holding = false;
      for (const message of held) ws.send(message);
    }, wait);
  });
}

// Puts a page's realtime sockets under the test's control. cut() closes the
// open ones (the phone reconnects within a second). While `refuse` is set,
// new ones are closed at once: the socket is down, HTTP still works. While
// `dropAcks` is set, the server's answers to the phone's events are lost
// (pings and pushes still go through), as with an answer that the link takes
// down with it, or one that never comes in time.
async function controlSockets(page: Page) {
  const control = { refuse: false, dropAcks: false, droppedAcks: 0, cut: () => {} };
  const open = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    if (control.refuse) {
      void ws.close();
      return;
    }
    const server = ws.connectToServer();
    open.add(ws);
    server.onMessage((message) => {
      // Socket.IO acks are "43<id>[...]" frames.
      if (control.dropAcks && typeof message === 'string' && message.startsWith('43')) {
        control.droppedAcks += 1;
        return;
      }
      ws.send(message);
    });
  });
  control.cut = () => {
    for (const ws of open) void ws.close();
    open.clear();
  };
  return control;
}

async function pickGame(page: Page, title: string) {
  await page
    .locator('.game-card')
    .filter({ has: page.locator('.game-card-title', { hasText: new RegExp(`^${title}$`) }) })
    .click();
}

test('a host who leaves hands the room over at once', async ({ browser, request }) => {
  const slug = await newLobby(request);
  const alex = await phonePage(browser, 'Alex');
  await joinByLink(alex, slug);
  const bea = await phonePage(browser, 'Bea');
  await joinByLink(bea, slug);
  await expect(alex.locator('.host-pill')).toBeVisible();
  await expect(bea.locator('.host-pill')).toHaveCount(0);

  await alex.getByRole('button', { name: /Leave/ }).click();
  await expect(alex).toHaveURL(/\/$/);

  // Without a leave the server would keep Alex (and the host role) for the
  // whole reconnect grace of ten minutes.
  await expect(bea.locator('.host-pill')).toBeVisible({ timeout: 10_000 });
  await expect(bea.getByRole('button', { name: /starten/ })).toBeVisible();
  const lobby = await lobbyOf(request, slug);
  expect(lobby.players.map((p) => p.name)).toEqual(['Bea']);

  await alex.close();
  await bea.close();
});

test('a phone whose socket is down still leaves the room at once', async ({ browser, request }) => {
  const slug = await newLobby(request);
  const alex = await phonePage(browser, 'Alex');
  const sockets = await controlSockets(alex);
  await joinByLink(alex, slug);
  const bea = await phonePage(browser, 'Bea');
  await joinByLink(bea, slug);
  await expect(alex.locator('.host-pill')).toBeVisible();

  sockets.refuse = true;
  sockets.cut();
  await expect(alex.locator('.reconnect-pill')).toBeVisible({ timeout: 10_000 });

  await alex.getByRole('button', { name: /Leave/ }).click();
  await expect(alex).toHaveURL(/\/$/);
  // The leave went over HTTP. The room only learns of the dropped socket
  // itself after the quiet window, and that keeps the host role anyway.
  await expect(bea.locator('.host-pill')).toBeVisible({ timeout: 4_000 });
  expect((await lobbyOf(request, slug)).players.map((p) => p.name)).toEqual(['Bea']);

  await alex.close();
  await bea.close();
});

test('a lost answer to an older reconnect does not throw out the phone a newer one brought back', async ({ browser, request }) => {
  const slug = await newLobby(request);
  const alex = await phonePage(browser, 'Alex');
  const sockets = await controlSockets(alex);
  await joinByLink(alex, slug);

  // The link drops. The phone reconnects and asks for its seat, but the
  // answer is lost with the link, which drops again.
  sockets.dropAcks = true;
  sockets.cut();
  await expect.poll(() => sockets.droppedAcks, { timeout: 10_000 }).toBeGreaterThan(0);
  const lostAt = Date.now();
  sockets.cut();
  sockets.dropAcks = false;
  // The next reconnect gets its answer.
  await expect(alex.locator('.reconnect-pill')).toHaveCount(0, { timeout: 10_000 });

  // Past the 8 s after which the lost one gives up.
  await alex.waitForTimeout(Math.max(0, lostAt + 9_000 - Date.now()));
  await expect(alex.getByRole('heading', { name: 'Controller join failed' })).toHaveCount(0);
  await expect(alex.locator('.host-pill')).toBeVisible();
  expect((await lobbyOf(request, slug)).players.map((p) => p.name)).toEqual(['Alex']);

  await alex.close();
});

test('a reconnect the room does not answer in time keeps the controller and asks again', async ({ browser, request }) => {
  const slug = await newLobby(request);
  const alex = await phonePage(browser, 'Alex');
  const sockets = await controlSockets(alex);
  await joinByLink(alex, slug);

  sockets.dropAcks = true;
  sockets.cut();
  await expect.poll(() => sockets.droppedAcks, { timeout: 10_000 }).toBeGreaterThan(0);
  const lostAt = Date.now();
  // The link stays up, but no answer comes before the 8 s timeout: that
  // is no reason to give up the seat.
  await alex.waitForTimeout(Math.max(0, lostAt + 8_500 - Date.now()));
  await expect(alex.getByRole('heading', { name: 'Controller join failed' })).toHaveCount(0);
  await expect(alex.locator('.reconnect-pill')).toBeVisible();

  // Asked again, and answered this time.
  sockets.dropAcks = false;
  await expect(alex.locator('.reconnect-pill')).toHaveCount(0, { timeout: 10_000 });
  await expect(alex.locator('.host-pill')).toBeVisible();

  await alex.close();
});

test('a single player can start a game made for one', async ({ browser, request }) => {
  const slug = await newLobby(request);
  const tv = await desktopPage(browser);
  await tv.goto('/l/' + slug);
  const alex = await phonePage(browser, 'Alex');
  await joinByLink(alex, slug);

  await pickGame(alex, 'Tap Race');
  const start = alex.getByRole('button', { name: /Tap Race starten/i });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(tv.locator('[data-testid="game-host-stage"]')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });

  await tv.close();
  await alex.close();
});

test('a phone the room no longer knows shows the join screen instead of a dead controller', async ({ browser, request }) => {
  test.setTimeout(90_000);
  const slug = await newLobby(request);
  const alex = await phonePage(browser, 'Alex');
  await joinByLink(alex, slug);
  const bea = await phonePage(browser, 'Bea');
  await joinByLink(bea, slug);
  await pickGame(alex, 'Tap Race');
  await alex.getByRole('button', { name: /Tap Race starten/i }).click();
  await expect(bea.getByRole('button', { name: /TAP!/i })).toBeVisible({ timeout: 15_000 });

  // While Bea is away the room drops her (like after the reconnect grace):
  // her token means nothing to it anymore.
  await bea.evaluate((s) => window.localStorage.setItem(`couch:player-token:${s}`, 'token_forgotten'), slug);
  await bea.context().setOffline(true);
  await expect(bea.locator('.reconnect-pill')).toBeVisible({ timeout: 25_000 });
  await bea.context().setOffline(false);

  // The game is running, so the room refuses her as a newcomer.
  await expect(bea.getByRole('heading', { name: 'Controller join failed' })).toBeVisible({ timeout: 20_000 });
  await expect(bea.locator('.error-line')).toContainText(/läuft schon/);
  expect(await bea.evaluate((s) => window.localStorage.getItem(`couch:player-token:${s}`), slug)).toBeNull();

  await alex.close();
  await bea.close();
});

test('a first join that times out is not carried out later behind the phone\'s back', async ({ browser, request }) => {
  test.setTimeout(90_000);
  const slug = await newLobby(request);
  const alex = await phonePage(browser, 'Alex');
  await slowFirstConnection(alex);
  await alex.goto('/j/' + slug);
  await expect(alex).toHaveURL(new RegExp('/c/' + slug), { timeout: 15_000 });
  await expect(alex.getByRole('heading', { name: 'Controller join failed' })).toBeVisible({ timeout: 15_000 });

  // The socket is through now. Nobody joined in the meantime: a join that
  // went out late would sit in the room as host, with no phone behind it.
  await alex.waitForTimeout(2_000);
  expect((await lobbyOf(request, slug)).players).toEqual([]);

  await alex.getByRole('button', { name: /Try again/ }).click();
  await expect(alex.locator('.host-pill')).toBeVisible({ timeout: 15_000 });
  expect((await lobbyOf(request, slug)).players.map((p) => p.name)).toEqual(['Alex']);

  await alex.close();
});

test('the attract screen renews a screen id the server says has expired', async ({ browser, request }) => {
  test.setTimeout(60_000);
  const tv = await desktopPage(browser);
  await tv.goto('/');
  await expect
    .poll(() => tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const screenId = (await tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')))!;
  const screenAt = async () => {
    const res = await request.get(`${REALTIME_URL}/api/screens/${screenId}`);
    return (await res.json()).screen as { expiresAt: string; expired: boolean };
  };
  const before = await screenAt();
  expect(before.expired).toBe(false);

  // The TV's poll learns its id is dead (as after ten unscanned minutes).
  await tv.route(`**/api/screens/${screenId}`, (route) =>
    route.fulfill({
      json: { screen: { id: screenId, expiresAt: new Date().toISOString(), claimedSlug: null, expired: true } }
    })
  );
  // It registers again, which keeps the id alive for another ten minutes.
  await expect
    .poll(async () => Date.parse((await screenAt()).expiresAt), { timeout: 15_000 })
    .toBeGreaterThan(Date.parse(before.expiresAt));

  await tv.close();
});
