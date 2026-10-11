import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser } from '@playwright/test';

const inputLabManifest = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/input-lab/couch.game.json'),
  'utf-8'
);

// Covers the /dev onboarding hero and the rendered /guide page (task T2).
// The hero funnels a creator through: (1) copy the guide for their AI, (2) degit
// the starter, (3) test + publish below. The guide page is a build-time static
// HTML render of the canonical COUCH-GAME-GUIDE.md.

test('/dev renders the 3-step hero and keeps the manifest section', async ({ page }) => {
  await page.goto('/dev');

  // The three hero step titles are the load-bearing onboarding copy.
  await expect(page.getByRole('heading', { name: 'Copy the guide, paste it into your coding agent' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Start from the working template' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Validate, test, publish' })).toBeVisible();

  // The existing manifest section must still be present below the hero.
  await expect(page.getByRole('heading', { name: '1. Manifest' })).toBeVisible();
  await expect(page.getByLabel('Game manifest JSON')).toBeVisible();
});

test('Copy-the-guide button flips to Copied OR opens the fallback textarea', async ({ page, context, browserName }) => {
  // Grant clipboard perms where supported (chromium). On other engines the
  // grant may be unsupported — the clipboard write then throws and the app must
  // fall back to the select-all textarea. Either outcome is a pass.
  if (browserName === 'chromium') {
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    } catch {
      // Some device profiles reject the grant; the fallback path covers it.
    }
  }

  await page.goto('/dev');

  const copyBtn = page.getByRole('button', { name: 'Copy the guide for your AI' });
  await expect(copyBtn).toBeVisible();
  await copyBtn.click();

  const copiedBtn = page.getByRole('button', { name: 'Copied — paste it into Claude/Cursor/ChatGPT' });
  const fallback = page.getByLabel('Guide text to copy');

  // Assert exactly one of the two success signals occurred: either the button
  // flipped to the Copied label, or the fallback textarea appeared (both carry
  // the prepended contract instruction).
  await expect(copiedBtn.or(fallback)).toBeVisible({ timeout: 10_000 });
});

test('/guide.html is served as a full styled guide page', async ({ request }) => {
  const res = await request.get('/guide.html');
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('Creator Guide');
  expect(body).toContain('couch.game.json');
});

test('/guide redirects to guide.html with the top bar visible', async ({ page }) => {
  await page.goto('/guide');
  await expect(page).toHaveURL(/guide\.html/, { timeout: 10_000 });
  await expect(page.getByRole('navigation', { name: 'Guide navigation' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Publish a game' })).toBeVisible();
});

// Load the input-lab fixture into the /dev test harness and wait for the
// handshake. The harness is a desktop tool: drive it at a desktop size in both
// projects.
async function startHarness(browser: Browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, isMobile: false, hasTouch: false });
  const logs: string[] = [];
  page.on('console', (msg) => logs.push(msg.text()));
  await page.goto('/dev');
  await page.getByLabel('Game manifest JSON').fill(inputLabManifest);
  await expect(page.getByText('Manifest valid')).toBeVisible();
  await page.getByRole('button', { name: 'Test game' }).click();
  await expect(page.getByText('Game ready (handshake OK)')).toBeVisible({ timeout: 20_000 });
  const game = page.frames().find((f) => f.url().includes('/input-lab/'))!;
  return { page, logs, game };
}

test('/dev test harness: Stop reaches the game as abort', async ({ browser }) => {
  const { page, logs } = await startHarness(browser);
  // Unmounting the stage removes the iframe; the SDK still tells the game.
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('[data-testid="game-host-stage"]')).toHaveCount(0);
  await expect.poll(() => logs.filter((l) => l === '[input-lab] abort host-unmounted').length).toBe(1);
  await page.close();
});

test('/dev test harness: a setController patch a live couch would reject shows why', async ({ browser }) => {
  const { page, game } = await startHarness(browser);
  // input-lab exposes its handle; the platform server refuses this patch.
  await game.evaluate(() =>
    (window as unknown as { couch: { setController(id: string, patch: unknown): void } }).couch.setController(
      'dev-alex',
      { labels: { fire: 'SHIELD', nope: 'X' } }
    )
  );
  await expect(page.getByText('setController rejected: unknown control "nope" in labels')).toBeVisible();
  await page.close();
});
