import { expect, test, type Browser } from '@playwright/test';

// The catalog draws creator-supplied thumbnails on every TV and phone, so
// nothing in a manifest may break it or make the screen load something. And a
// TV's first-load probe result counts once per game session, from the host
// screen only.

const API = 'http://127.0.0.1:4100/api';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function desktopPage(browser: Browser) {
  return browser.newPage({ viewport: { width: 1440, height: 960 }, isMobile: false, hasTouch: false, userAgent: DESKTOP_UA });
}

function hostileGame(id: string, title: unknown, thumbnail: unknown) {
  return {
    id,
    title,
    description: 'Hostile catalog entry.',
    minPlayers: 1,
    maxPlayers: 4,
    controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'tap', type: 'button', label: 'Tap' }] },
    aspectRatio: '16:9',
    estimatedDurationMinutes: 2,
    status: 'published',
    origin: 'external',
    entryUrl: 'https://games.example.com/hostile/',
    sdkProtocol: 1,
    publishedAt: '2026-10-01T00:00:00.000Z',
    thumbnail
  };
}

test('a TV lobby survives catalog entries with hostile thumbnails', async ({ browser, request }) => {
  const created = await request.post(`${API}/lobbies`, { data: {} });
  const slug = (await created.json()).lobby.slug as string;
  const tv = await desktopPage(browser);
  const tracker: string[] = [];
  tv.on('request', (req) => {
    if (req.url().includes('tracker')) tracker.push(req.url());
  });
  const consoleErrors: string[] = [];
  tv.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  // Serve the real catalog plus entries the server would no longer accept
  // (an old record, another deployment): lucide internals as icons, a url()
  // gradient, a card that can't be drawn at all.
  await tv.route(/\/api\/games$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.games.push(
      hostileGame('icon-export', 'Icon Export', {
        kind: 'css',
        gradient: 'url(http://127.0.0.1:4180/tracker.gif?x=1) center/cover',
        icon: 'Icon'
      }),
      hostileGame('icons-export', 'Icons Export', { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'icons' }),
      hostileGame('factory-export', 'Factory Export', {
        kind: 'css',
        gradient: 'linear-gradient(red, blue), url(http://127.0.0.1:4180/tracker-layer.gif)',
        icon: 'createLucideIcon'
      }),
      hostileGame('lowercase-zap', 'Lowercase Zap', { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'zap' }),
      hostileGame('broken-title', { not: 'a string' }, { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'zap' })
    );
    await route.fulfill({ response, json: body });
  });

  await tv.goto(`/l/${slug}`);
  const card = (title: string) =>
    tv.locator('.play-surface .game-card').filter({ has: tv.locator('.game-card-title', { hasText: new RegExp(`^${title}$`) }) });

  // The lobby is still there, with the built-in games...
  await expect(card('Trebuchet')).toBeVisible({ timeout: 15_000 });
  // ...and each hostile card drawn with the fallback icon and gradient.
  for (const title of ['Icon Export', 'Icons Export', 'Factory Export']) {
    await expect(card(title)).toBeVisible();
    await expect(card(title).locator('.game-card-icon svg.lucide-gamepad-2')).toBeVisible();
    const background = await card(title)
      .locator('.game-card-thumb')
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(background).toContain('linear-gradient');
    expect(background).not.toContain('url(');
  }
  // A lowercase name from the guide gets its real icon.
  await expect(card('Lowercase Zap').locator('.game-card-icon svg.lucide-zap')).toBeVisible();
  // The card that can't be drawn failed on its own and was left out, while
  // every other card above is still there.
  await expect.poll(() => consoleErrors.some((text) => text.includes('Game card failed to render'))).toBe(true);
  expect(tracker).toEqual([]);
  await tv.close();
});

test('the publish API refuses thumbnails the catalog would not draw', async ({ request }) => {
  const base = {
    id: `thumb-${Date.now().toString(36)}`,
    title: 'Thumb Check',
    description: 'Never published.',
    minPlayers: 1,
    maxPlayers: 4,
    controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'tap', type: 'button', label: 'Tap' }] },
    aspectRatio: '16:9',
    estimatedDurationMinutes: 2,
    entryUrl: 'http://127.0.0.1:4180/tap-race/index.html',
    sdkProtocol: 1
  };
  const badIcon = await request.post(`${API}/games`, {
    data: { manifest: { ...base, thumbnail: { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'createLucideIcon' } } }
  });
  expect(badIcon.status()).toBe(422);
  expect(JSON.stringify(await badIcon.json())).toContain('thumbnail.icon');
  const badGradient = await request.post(`${API}/games`, {
    data: { manifest: { ...base, thumbnail: { kind: 'css', gradient: 'url(https://tracker.example/p.gif)', icon: 'zap' } } }
  });
  expect(badGradient.status()).toBe(422);
  expect(JSON.stringify(await badGradient.json())).toContain('thumbnail.gradient');
});
