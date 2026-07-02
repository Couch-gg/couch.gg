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

  // Alex selects the Tap Race game card, then starts it. Exact title match: the
  // registry is shared across the whole suite run, so a substring match on
  // 'Tap Race' would also catch a published 'Tap Race Two' from another test.
  await alex
    .locator('.game-card')
    .filter({ has: alex.locator('.game-card-title', { hasText: /^Tap Race$/ }) })
    .click();
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
  await expect(
    tv.locator('.play-surface .game-card').filter({ has: tv.locator('.game-card-title', { hasText: /^Tap Race$/ }) })
  ).toBeVisible({ timeout: 15_000 });

  await tv.close();
  await alex.close();
  await bea.close();
});

test('PUBLISH flow: submit via REST, play it, unpublish', async ({ browser, request }) => {
  test.setTimeout(120_000);

  const gameId = `tap-race-${Date.now().toString(36)}`;
  const manifest = {
    id: gameId,
    title: 'Tap Race Two',
    description: 'First to 5 taps wins. A minimal fixture game for the external-game e2e slice.',
    minPlayers: 1,
    maxPlayers: 8,
    controllerLayout: {
      kind: 'generic-buttons',
      controls: [{ control: 'tap', type: 'button', label: 'TAP!' }]
    },
    aspectRatio: '16:9',
    estimatedDurationMinutes: 2,
    thumbnail: {
      kind: 'css',
      gradient: 'linear-gradient(160deg,#12324d,#2d8fbe)',
      icon: 'zap'
    },
    entryUrl: 'http://127.0.0.1:4180/tap-race/index.html',
    sdkProtocol: 1,
    supportsRemote: true
  };

  // Submit via REST — the same path DevSubmitRoute's "Publish" button hits.
  const submitRes = await request.post('http://127.0.0.1:4100/api/games', { data: { manifest } });
  expect(submitRes.status()).toBe(201);
  const submitBody = await submitRes.json();
  expect(submitBody.game?.id).toBe(gameId);
  const managementToken = submitBody.managementToken as string;
  expect(managementToken).toBeTruthy();

  // TV + phone local-pair, plus a second player (the app requires >= 2 players to start).
  const { tv, screenId } = await attractScreenId(browser);
  const alex = await phonePage(browser, 'Alex');
  await alex.goto('/s/' + screenId + '?mode=local');
  await expect(alex).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = alex.url().split('/').pop()!;
  await expect(tv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible({ timeout: 15_000 });

  const bea = await phonePage(browser, 'Bea');
  await bea.goto('/j/' + slug);
  await expect(bea).toHaveURL(new RegExp('/c/' + slug), { timeout: 15_000 });
  await expect(tv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });

  // The catalog card for the newly-published game shows the Community badge.
  // Exact title match: the registry is shared across the whole suite run, so a
  // substring match on 'Tap Race Two' could hit a stray record from a retry.
  const card = alex.locator('.game-card').filter({ has: alex.locator('.game-card-title', { hasText: 'Tap Race Two' }) });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('.game-badge', { hasText: 'Community' })).toBeVisible();

  // Select + start.
  await card.click();
  const start = alex.getByRole('button', { name: /Tap Race Two starten/i });
  await expect(start).toBeEnabled();
  await start.click();

  // TV: the external game host stage mounts and the iframe handshakes.
  const stage = tv.locator('[data-testid="game-host-stage"]');
  await expect(stage).toBeVisible({ timeout: 20_000 });
  await expect(stage).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });

  const frame = tv.frameLocator('iframe[title="Tap Race Two"]');
  await expect(frame.locator('[data-testid^="lane-"]', { hasText: 'Alex' })).toBeVisible({ timeout: 20_000 });

  // One tap registers in-frame — proves the published game's entryUrl is the
  // same real fixture and the input relay works end to end for a submitted game.
  const tapButton = alex.getByRole('button', { name: /TAP!/i });
  await expect(tapButton).toBeVisible();
  const laneCount = frame.locator('[data-testid^="count-"]').first();
  await tapButton.click();
  await expect(laneCount).toHaveText('1', { timeout: 10_000 });

  // Unpublish with the management token.
  const deleteRes = await request.delete('http://127.0.0.1:4100/api/games/' + gameId, {
    headers: { 'x-management-token': managementToken }
  });
  expect(deleteRes.status()).toBe(204);

  // The catalog REST no longer lists it (the lobby may still be mid-round — not asserted).
  const catalogRes = await request.get('http://127.0.0.1:4100/api/games');
  expect(catalogRes.status()).toBe(200);
  const catalogBody = await catalogRes.json();
  const ids = (catalogBody.games as Array<{ id: string }>).map((g) => g.id);
  expect(ids).not.toContain(gameId);

  await tv.close();
  await alex.close();
  await bea.close();
});

test('REMOTE determinism: two TVs converge on the same input log', async ({ browser }) => {
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

  await expect(guestTv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });
  await expect(guestTv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });
  await expect(hostTv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });
  await expect(guestTv.locator('.player-name', { hasText: 'Alex' })).toBeVisible({ timeout: 15_000 });

  // Select the env-registered 'Tap Race' (supportsRemote true) + start. Exact
  // title match — see the comment in the EXTERNAL game test above.
  await alex
    .locator('.game-card')
    .filter({ has: alex.locator('.game-card-title', { hasText: /^Tap Race$/ }) })
    .click();
  const start = alex.getByRole('button', { name: /Tap Race starten/i });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();

  // BOTH TVs' iframes handshake.
  const hostStage = hostTv.locator('[data-testid="game-host-stage"]');
  const guestStage = guestTv.locator('[data-testid="game-host-stage"]');
  await expect(hostStage).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  await expect(guestStage).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });

  const hostFrame = hostTv.frameLocator('iframe[title="Tap Race"]');
  const guestFrame = guestTv.frameLocator('iframe[title="Tap Race"]');
  await expect(hostFrame.locator('[data-testid^="lane-"]', { hasText: 'Alex' })).toBeVisible({ timeout: 20_000 });
  await expect(guestFrame.locator('[data-testid^="lane-"]', { hasText: 'Alex' })).toBeVisible({ timeout: 20_000 });

  // Alex taps 3 times, 250ms apart — comfortably under the per-player (20 cap,
  // 10/s refill) and per-slug rate limits.
  const tapButton = alex.getByRole('button', { name: /TAP!/i });
  await expect(tapButton).toBeVisible();
  for (let i = 0; i < 3; i += 1) {
    await tapButton.click();
    await alex.waitForTimeout(250);
  }

  // Both TVs' frames show Alex's count = 3. The host TV is on the fast socket
  // path; the guest TV may only converge via the 750ms persisted-inputLog poll,
  // hence the longer timeout — this is the assertion that proves the persisted
  // relay (not socket luck).
  const hostAlexCount = hostFrame.locator('[data-testid^="count-"]').first();
  const guestAlexCount = guestFrame.locator('[data-testid^="count-"]').first();
  await expect(hostAlexCount).toHaveText('3', { timeout: 10_000 });
  await expect(guestAlexCount).toHaveText('3', { timeout: 10_000 });

  await hostTv.close();
  await alex.close();
  await guestTv.close();
  await bea.close();
});

test('DEV simulator: fixture standalone shows sim overlay', async ({ page }) => {
  await page.goto('http://127.0.0.1:4180/tap-race/index.html');
  const simRoot = page.locator('#couch-sim-root');
  await expect(simRoot).toBeVisible({ timeout: 15_000 });

  const phones = simRoot.locator('.couch-sim-phone');
  await expect(phones).toHaveCount(2);

  const firstPad = phones.first().locator('.couch-sim-pad-button');
  await firstPad.click();

  const laneCount = page.locator('[data-testid^="count-"]').first();
  await expect(laneCount).toHaveText('1', { timeout: 10_000 });
});
