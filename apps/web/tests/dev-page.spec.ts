import { expect, test } from '@playwright/test';

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
