import { expect, test } from '@playwright/test';

// apps/web/public/shared/{sim,constants}.js are generated from the built
// @couch/trebuchet package by scripts/copy-sdk.mjs before dev and build. The
// original Phaser scenes under public/js/ import them from /shared/ in the
// browser, so the TV stage must still find them there.

for (const file of ['constants.js', 'sim.js']) {
  test(`/shared/${file} is served from the Trebuchet build`, async ({ request }) => {
    const res = await request.get('/shared/' + file);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/javascript/);
    const body = await res.text();
    expect(body).toContain('GENERATED from packages/games/trebuchet/src/');
    expect(body).not.toContain('sourceMappingURL');
  });
}

test('the Trebuchet stage loads the shared sim modules', async ({ page }) => {
  const shared = (name: string) => page.waitForResponse((res) => new URL(res.url()).pathname === '/shared/' + name);
  const constants = shared('constants.js');
  const sim = shared('sim.js');

  await page.goto('/games/trebuchet');
  expect((await constants).status()).toBe(200);
  expect((await sim).status()).toBe(200);
  await expect(page.getByTestId('trebuchet-stage').locator('canvas')).toBeVisible({ timeout: 30_000 });
});
