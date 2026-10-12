import { expect, test, type Browser } from '@playwright/test';

// Covers the Vite dev proxy for /api/realtime. A TV or phone that opens the dev
// server on any host other than localhost/127.0.0.1/0.0.0.0 (in practice the
// LAN IP) uses the production paths on its own origin. tv.localhost resolves to
// loopback and Vite allows it by default, yet the client does not treat it as a
// local dev host, so it exercises the same paths a LAN device does.

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function lanOrigin(baseURL: string | undefined) {
  const url = new URL(baseURL ?? 'http://127.0.0.1:5173');
  url.hostname = 'tv.localhost';
  return url.origin;
}

async function phonePage(browser: Browser, name: string) {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await p.addInitScript((n) => window.localStorage.setItem('couch:name', n), name);
  return p;
}

test('/api/realtime on the web origin answers with realtime JSON', async ({ request }) => {
  const res = await request.get('/api/realtime/health');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(await res.json()).toMatchObject({ ok: true });
});

test('LAN host: TV and phone reach realtime through the dev proxy', async ({ browser, baseURL }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, 'The dev proxy only exists on the local Vite server.');
  test.setTimeout(90_000);
  const origin = lanOrigin(baseURL);
  const wsOrigin = origin.replace(/^http/, 'ws');

  const tv = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    isMobile: false,
    hasTouch: false,
    userAgent: DESKTOP_UA
  });
  const tvSockets: string[] = [];
  tv.on('websocket', (ws) => tvSockets.push(ws.url()));
  await tv.goto(origin + '/');
  await expect(tv.locator('.attract-shell')).toBeVisible();
  // The TV registers its screen over the socket, which must have connected on
  // its own origin rather than on :4100.
  await expect
    .poll(() => tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const screenId = await tv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));
  expect(tvSockets.some((u) => u.startsWith(wsOrigin + '/api/realtime/socket.io/'))).toBe(true);

  // The phone scans the Local QR on the same host: its REST calls (screen
  // lookup, lobby create, claim) also go through the proxy, and the TV sees the
  // player arrive over its socket.
  const alex = await phonePage(browser, 'Alex');
  const phoneCalls: string[] = [];
  alex.on('request', (req) => {
    if (req.url().includes('/api/realtime/')) phoneCalls.push(req.url());
  });
  await alex.goto(origin + '/s/' + screenId + '?mode=local');
  await expect(alex).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = alex.url().split('/').pop()!;
  expect(phoneCalls).toContain(origin + '/api/realtime/lobbies');
  await expect(tv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });
  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible({ timeout: 15_000 });

  await tv.close();
  await alex.close();
});
