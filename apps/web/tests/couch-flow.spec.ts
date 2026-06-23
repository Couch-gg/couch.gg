import { expect, test } from '@playwright/test';

test('standalone Trebuchet test route renders and fires a shot', async ({ page }) => {
  await page.goto('/games/trebuchet');
  await expect(page.getByText('/games/trebuchet')).toBeVisible();
  await expect(page.getByTestId('trebuchet-stage').locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: /Fire test shot/i }).click();
  await expect(page.getByText(/Alex|Bea|Winner|Finished/i).first()).toBeVisible();
});

test('TV lobby can be started from phone controllers', async ({ browser }) => {
  const tv = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await tv.goto('/');
  await tv.getByRole('button', { name: /Neue Lobby erstellen/i }).click();
  await expect(tv).toHaveURL(/\/l\/[A-Z0-9]+/);
  const slug = tv.url().split('/').pop()!;

  const phoneOne = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await phoneOne.goto('/c/' + slug);
  await phoneOne.getByLabel(/Your name/i).fill('Alex');
  await phoneOne.getByRole('button', { name: /^Join$/i }).click();

  const phoneTwo = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await phoneTwo.goto('/c/' + slug);
  await phoneTwo.getByLabel(/Your name/i).fill('Bea');
  await phoneTwo.getByRole('button', { name: /^Join$/i }).click();

  await expect(tv.locator('.player-name', { hasText: 'Alex' })).toBeVisible();
  await expect(tv.locator('.player-name', { hasText: 'Bea' })).toBeVisible();
  await expect(phoneOne.getByRole('button', { name: /Trebuchet starten/i })).toBeEnabled();
  await phoneOne.getByRole('button', { name: /Trebuchet starten/i }).click();

  await expect(tv.getByText('Live')).toBeVisible();
  await expect(tv.getByTestId('trebuchet-stage').locator('canvas')).toBeVisible();
  await expect(tv.getByTestId('trebuchet-stage')).toHaveAttribute('data-phase', 'running');
  await expect(phoneOne.getByText(/Your turn|Waiting/i)).toBeVisible();
  await expect(phoneTwo.getByText(/Your turn|Waiting/i)).toBeVisible();

  await tv.close();
  await phoneOne.close();
  await phoneTwo.close();
});
