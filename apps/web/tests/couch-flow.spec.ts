import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import { io as connectSocket, type Socket } from 'socket.io-client';

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

const REALTIME_URL = 'http://127.0.0.1:4100';

// A bare realtime connection, standing in for another device.
function realtimeSocket(): Socket {
  return connectSocket(REALTIME_URL, { transports: ['websocket'], forceNew: true });
}

function ack<T = { ok: boolean }>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function newLobby(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${REALTIME_URL}/api/lobbies`, { data: {} });
  return (await res.json()).lobby.slug;
}

async function lobbyScreens(request: APIRequestContext, slug: string): Promise<string[]> {
  const res = await request.get(`${REALTIME_URL}/api/lobbies/${slug}`);
  return (await res.json()).lobby.screens;
}

async function attractScreenId(browser: Browser) {
  const tv = await desktopPage(browser);
  await tv.goto('/');
  await expect(tv.locator('.attract-shell')).toBeVisible();
  await expect(tv.getByRole('heading', { name: 'Local Couch' })).toBeVisible();
  await expect(tv.getByRole('heading', { name: 'Remote Couch' })).toBeVisible();
  // The footer shows the real serving host (couch.gg is a parked domain).
  await expect(tv.getByText(/Made a game\? .+\/dev/)).toBeVisible();
  await expect
    .poll(() => tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const screenId = await tv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));
  return { tv, screenId: screenId! };
}

test('standalone Trebuchet test route renders and fires a shot', async ({ page }) => {
  await page.goto('/games/trebuchet');
  await expect(page.getByText('/games/trebuchet')).toBeVisible();
  await expect(page.getByTestId('trebuchet-stage').locator('canvas')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Fire test shot/i }).click();
  await expect(page.getByText(/Alex|Bea|Winner|Finished/i).first()).toBeVisible({ timeout: 30_000 });
});

test('phone home points to a shared screen (no create/join)', async ({ browser }) => {
  const phone = await phonePage(browser, 'Solo');
  await phone.goto('/');
  await expect(phone.getByText(/Scan a TV to begin/i)).toBeVisible();
  await expect(phone.getByRole('button', { name: /Create a room/i })).toHaveCount(0);
  const buildLink = phone.getByRole('link', { name: /Build your own game/i });
  await expect(buildLink).toBeVisible();
  await expect(buildLink).toHaveAttribute('href', '/dev');
  await phone.close();
});

test('LOCAL couch: scan a TV -> auto-create, second phone joins via invite, game starts', async ({ browser }) => {
  test.setTimeout(90_000);
  const { tv, screenId } = await attractScreenId(browser);

  // Phone scans the Local QR -> auto-creates a room and claims this screen.
  const alex = await phonePage(browser, 'Alex');
  await alex.goto('/s/' + screenId + '?mode=local');
  await expect(alex).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = alex.url().split('/').pop()!;
  await expect(tv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible({ timeout: 15_000 });

  // Second player opens the lobby invite -> phone auto-opens the controller.
  const bea = await phonePage(browser, 'Bea');
  await bea.goto('/j/' + slug);
  await expect(bea).toHaveURL(new RegExp('/c/' + slug), { timeout: 15_000 });
  await expect(tv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });

  // Chat + start.
  const chat = alex.getByPlaceholder(/Message/i);
  await chat.fill('gg');
  await chat.press('Enter');
  await expect(tv.locator('.chat-msg-text', { hasText: 'gg' })).toBeVisible({ timeout: 10_000 });
  await expect(alex.locator('.publish-card')).toBeVisible();
  await expect(alex.locator('.publish-card')).toHaveAttribute('href', '/dev');
  await alex.locator('.game-card', { hasText: 'Trebuchet' }).click();
  const start = alex.getByRole('button', { name: /Trebuchet starten/i });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(tv.getByText('Live')).toBeVisible({ timeout: 10_000 });

  await tv.close();
  await alex.close();
  await bea.close();
});

test('REMOTE couch: two separate TVs pair to one room by number', async ({ browser }) => {
  test.setTimeout(120_000);

  // Host: their own TV + phone -> Host Game.
  const { tv: hostTv, screenId: hostScreen } = await attractScreenId(browser);
  const alex = await phonePage(browser, 'Alex');
  await alex.goto('/s/' + hostScreen + '?mode=remote');
  await alex.getByRole('button', { name: /Host Game/i }).click();
  await expect(alex).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = alex.url().split('/').pop()!;
  await expect(hostTv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });
  await expect(hostTv.locator('.player-name', { hasText: 'Alex' })).toBeVisible({ timeout: 15_000 });

  // Remote hosting prompts to share the room number — confirm it shows the code, then dismiss.
  await expect(alex.locator('.room-share-code')).toContainText(slug);
  await alex.getByRole('button', { name: /^Done$/i }).click();

  // Guest: a SEPARATE TV + phone -> Join Game by the host's room number.
  const { tv: guestTv, screenId: guestScreen } = await attractScreenId(browser);
  const bea = await phonePage(browser, 'Bea');
  await bea.goto('/s/' + guestScreen + '?mode=remote');
  await bea.getByRole('button', { name: /Join Game/i }).click();
  await bea.getByLabel(/Room number/i).fill(slug);
  await bea.getByRole('button', { name: /Join Game/i }).click();
  await expect(bea).toHaveURL(new RegExp('/c/' + slug), { timeout: 15_000 });

  // The guest's OWN TV joins the SAME lobby — two screens, one room.
  await expect(guestTv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });
  await expect(guestTv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });
  // Both TVs see both players.
  await expect(hostTv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });
  await expect(guestTv.locator('.player-name', { hasText: 'Alex' })).toBeVisible({ timeout: 15_000 });

  // Start — both TVs go live.
  await alex.locator('.game-card', { hasText: 'Trebuchet' }).click();
  const start = alex.getByRole('button', { name: /Trebuchet starten/i });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();
  await expect(hostTv.getByText('Live')).toBeVisible({ timeout: 12_000 });
  await expect(guestTv.getByText('Live')).toBeVisible({ timeout: 12_000 });

  await hostTv.close();
  await alex.close();
  await guestTv.close();
  await bea.close();
});

test('controller survives a network drop and auto-rejoins (slept phone)', async ({ browser }) => {
  test.setTimeout(90_000);
  const { tv, screenId } = await attractScreenId(browser);
  const alex = await phonePage(browser, 'Alex');
  await alex.goto('/s/' + screenId + '?mode=local');
  await expect(alex).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = alex.url().split('/').pop()!;
  await expect(tv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });

  const conn = tv.locator('.player-row', { hasText: 'Alex' }).locator('.connection');
  await expect(conn).toHaveText(/online/i, { timeout: 15_000 });
  await alex.context().setOffline(true);
  await expect(conn).toHaveText(/reconnect/i, { timeout: 20_000 });
  await alex.context().setOffline(false);
  await expect(conn).toHaveText(/online/i, { timeout: 20_000 });

  await tv.close();
  await alex.close();
});

test('a TV whose screen id another device joined with first takes a fresh one', async ({ browser, request }) => {
  const slug = await newLobby(request);
  // The id is public (pairing link, lobby snapshot), so someone can bind it first.
  const taken = `scr_taken${Date.now().toString(36)}`;
  const squatter = realtimeSocket();
  expect((await ack(squatter, 'screen:join', { slug, screenId: taken })).ok).toBe(true);

  const tv = await desktopPage(browser);
  await tv.addInitScript((id) => {
    if (!window.sessionStorage.getItem('couch:screenId')) window.sessionStorage.setItem('couch:screenId', id);
  }, taken);
  await tv.goto('/l/' + slug);
  await expect(tv.locator('.room-code strong')).toHaveText(slug);
  await expect
    .poll(() => tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .not.toBe(taken);
  const fresh = await tv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));
  await expect.poll(() => lobbyScreens(request, slug), { timeout: 10_000 }).toEqual([taken, fresh]);
  await expect(tv.locator('.status-panel')).toHaveCount(0);

  squatter.disconnect();
  await tv.close();
});

test('a TV the lobby dropped while it was still connected joins again', async ({ browser, request }) => {
  test.setTimeout(90_000);
  const slug = await newLobby(request);
  const tv = await desktopPage(browser);
  await tv.goto('/l/' + slug);
  await expect.poll(async () => (await lobbyScreens(request, slug)).length, { timeout: 15_000 }).toBe(1);
  const own = await tv.evaluate((s) => {
    const id = window.sessionStorage.getItem('couch:screenId')!;
    return { id, token: window.sessionStorage.getItem(`couch:screenToken:${s}:${id}`) };
  }, slug);
  expect(await lobbyScreens(request, slug)).toEqual([own.id]);

  const watcher = realtimeSocket();
  const snapshots: string[][] = [];
  watcher.on('lobby:snapshot', (lobby: { screens: string[] }) => snapshots.push(lobby.screens));
  expect((await ack(watcher, 'controller:join', { slug, name: 'Watcher' })).ok).toBe(true);

  // Another connection takes over the TV's screen id and goes away, so after
  // the grace period the server drops the screen while the TV page is still
  // connected (like a rejoin the record lost).
  const twin = realtimeSocket();
  expect((await ack(twin, 'screen:join', { slug, screenId: own.id, screenToken: own.token })).ok).toBe(true);
  twin.disconnect();
  await expect
    .poll(() => snapshots.some((screens) => !screens.includes(own.id)), { timeout: 25_000 })
    .toBe(true);

  // The TV sees a snapshot without itself and joins again.
  await expect.poll(() => lobbyScreens(request, slug), { timeout: 10_000 }).toEqual([own.id]);
  const dropped = snapshots.findIndex((screens) => !screens.includes(own.id));
  expect(snapshots.slice(dropped).some((screens) => screens.includes(own.id))).toBe(true);
  await expect(tv.locator('.status-panel')).toHaveCount(0);

  watcher.disconnect();
  await tv.close();
});
