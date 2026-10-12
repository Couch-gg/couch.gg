import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

// The TV's game stage across rounds, reloads, freshly published games and a
// slow first connection.

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
  return (await res.json()).lobby as { state: string; screens: string[]; players: unknown[] };
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

async function pickGame(page: Page, title: string) {
  await page
    .locator('.game-card')
    .filter({ has: page.locator('.game-card-title', { hasText: new RegExp(`^${title}$`) }) })
    .click();
}

// A TV on a fresh lobby with Alex (host) and Bea, Tap Race started.
async function tapRaceCouch(browser: Browser, request: APIRequestContext) {
  const slug = await newLobby(request);
  const tv = await desktopPage(browser);
  await tv.goto('/l/' + slug);
  const alex = await phonePage(browser, 'Alex');
  await joinByLink(alex, slug);
  const bea = await phonePage(browser, 'Bea');
  await joinByLink(bea, slug);
  await expect(tv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });
  await pickGame(alex, 'Tap Race');
  await alex.getByRole('button', { name: /Tap Race starten/i }).click();
  await expect(tv.locator('[data-testid="game-host-stage"]')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  const frame = tv.frameLocator('iframe[title="Tap Race"]');
  return { slug, tv, alex, bea, frame };
}

test('rounds: a quick restart gets a fresh game, the host can end one and pick another', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { slug, tv, alex, bea, frame } = await tapRaceCouch(browser, request);
  const tap = alex.getByRole('button', { name: /TAP!/i });
  const alexCount = frame.locator('[data-testid^="count-"]').first();

  for (let i = 1; i <= 5; i += 1) await tap.click();
  await expect(frame.locator('[data-testid="winner"]')).toContainText(/ALEX WINS!/i, { timeout: 10_000 });
  await expect.poll(async () => (await lobbyOf(request, slug)).state, { timeout: 10_000 }).toBe('ended');

  // Start the next round while the winner screen is still up: it must be a
  // new game (new seed, counts at zero), not the finished one taking taps.
  const again = alex.getByRole('button', { name: /Tap Race starten/i });
  await expect(again).toBeEnabled({ timeout: 10_000 });
  await again.click();
  await expect.poll(async () => (await lobbyOf(request, slug)).state, { timeout: 10_000 }).toBe('playing');
  await expect(frame.locator('[data-testid="winner"]')).toHaveText('', { timeout: 15_000 });
  await expect(alexCount).toHaveText('0', { timeout: 15_000 });
  await tap.click();
  await expect(alexCount).toHaveText('1', { timeout: 10_000 });

  // The host ends this round from the phone.
  alex.once('dialog', (dialog) => void dialog.accept());
  await alex.getByRole('button', { name: /Spiel beenden/ }).click();
  await expect.poll(async () => (await lobbyOf(request, slug)).state, { timeout: 10_000 }).toBe('ended');

  // And picks another game right away, without a new lobby.
  await pickGame(alex, 'Input Lab');
  await expect(tv.locator('.surface-topline h1')).toHaveText('Input Lab', { timeout: 10_000 });
  await expect(alex.getByRole('button', { name: /Input Lab starten/i })).toBeEnabled();

  await tv.close();
  await alex.close();
  await bea.close();
});

test('a TV reloaded mid-game replays the inputs so far', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { tv, alex, bea, frame } = await tapRaceCouch(browser, request);
  const tap = alex.getByRole('button', { name: /TAP!/i });
  const alexCount = frame.locator('[data-testid^="count-"]').first();
  for (let i = 1; i <= 3; i += 1) {
    await tap.click();
    await expect(alexCount).toHaveText(String(i), { timeout: 10_000 });
  }

  await tv.reload();
  await expect(tv.locator('[data-testid="game-host-stage"]')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  await expect(alexCount).toHaveText('3', { timeout: 15_000 });
  await tap.click();
  await expect(alexCount).toHaveText('4', { timeout: 10_000 });

  await tv.close();
  await alex.close();
  await bea.close();
});

test('a TV opened before a game was published still runs it', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const slug = await newLobby(request);
  const tv = await desktopPage(browser);
  const crashes: string[] = [];
  tv.on('pageerror', (err) => crashes.push(err.message));
  await tv.goto('/l/' + slug);
  await expect(tv.locator('.play-surface .game-card').first()).toBeVisible({ timeout: 15_000 });

  // Published while the TV already has its catalog.
  const gameId = `late-race-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const submit = await request.post(`${REALTIME_URL}/api/games`, {
    data: {
      manifest: {
        id: gameId,
        title: 'Late Race',
        description: 'Tap Race, published after the TV opened.',
        minPlayers: 1,
        maxPlayers: 8,
        controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'tap', type: 'button', label: 'TAP!' }] },
        aspectRatio: '16:9',
        estimatedDurationMinutes: 2,
        thumbnail: { kind: 'css', gradient: 'linear-gradient(160deg,#12324d,#2d8fbe)', icon: 'zap' },
        entryUrl: 'http://127.0.0.1:4180/tap-race/index.html',
        sdkProtocol: 1,
        supportsRemote: true
      }
    }
  });
  expect(submit.status()).toBe(201);
  const { managementToken } = await submit.json();

  // The phone joins afterwards, so its catalog has the game.
  const alex = await phonePage(browser, 'Alex');
  await joinByLink(alex, slug);
  await pickGame(alex, 'Late Race');
  await alex.getByRole('button', { name: /Late Race starten/i }).click();

  await expect(tv.locator('[data-testid="game-host-stage"]')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  const frame = tv.frameLocator('iframe[title="Late Race"]');
  await alex.getByRole('button', { name: /TAP!/i }).click();
  await expect(frame.locator('[data-testid^="count-"]').first()).toHaveText('1', { timeout: 10_000 });
  expect(crashes).toEqual([]);

  await request.delete(`${REALTIME_URL}/api/games/${gameId}`, { headers: { 'x-management-token': managementToken } });
  await tv.close();
  await alex.close();
});

test('a TV whose first connection is slow joins once it is through, without an error page', async ({ browser, request }) => {
  test.setTimeout(60_000);
  const slug = await newLobby(request);
  const tv = await desktopPage(browser);
  await slowFirstConnection(tv);
  await tv.goto('/l/' + slug);
  await expect(tv.locator('.room-code strong')).toHaveText(slug);
  await tv.waitForTimeout(9_000);
  await expect.poll(async () => (await lobbyOf(request, slug)).screens.length, { timeout: 15_000 }).toBe(1);
  await expect(tv.locator('.status-panel')).toHaveCount(0);

  await tv.close();
});
