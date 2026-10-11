import { expect, test, type Browser, type Page } from '@playwright/test';

// Action-game controls on the generic phone controller, driven against the
// "input-lab" fixture game, which logs every input it receives as JSON lines.

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

async function phonePage(browser: Browser, name: string, landscape = false) {
  const p = await browser.newPage({
    viewport: landscape ? { width: 844, height: 390 } : { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    // A landscape phone is wider than the 820px narrow cut-off, so device
    // detection needs the phone UA a real one sends.
    userAgent: PHONE_UA
  });
  await p.addInitScript((n) => window.localStorage.setItem('couch:name', n), name);
  return p;
}

async function startInputLab(browser: Browser, prepareAlex?: (page: Page) => Promise<void>) {
  const tv = await browser.newPage({ viewport: { width: 1440, height: 960 }, isMobile: false, hasTouch: false, userAgent: DESKTOP_UA });
  await tv.goto('/');
  await expect
    .poll(() => tv.evaluate(() => window.sessionStorage.getItem('couch:screenId')), { timeout: 15_000 })
    .toBeTruthy();
  const screenId = await tv.evaluate(() => window.sessionStorage.getItem('couch:screenId'));

  const alex = await phonePage(browser, 'Alex', true);
  await prepareAlex?.(alex);
  await alex.goto('/s/' + screenId + '?mode=local');
  await expect(alex).toHaveURL(/\/c\/[A-Z0-9]+/, { timeout: 15_000 });
  const slug = alex.url().split('/').pop()!;
  await expect(tv).toHaveURL(new RegExp('/l/' + slug), { timeout: 15_000 });

  const bea = await phonePage(browser, 'Bea');
  await bea.goto('/j/' + slug);
  await expect(tv.locator('.player-name', { hasText: 'Bea' })).toBeVisible({ timeout: 15_000 });

  await alex
    .locator('.game-card')
    .filter({ has: alex.locator('.game-card-title', { hasText: /^Input Lab$/ }) })
    .click();
  const start = alex.getByRole('button', { name: /Input Lab starten/i });
  await expect(start).toBeEnabled();
  await start.click();

  const stage = tv.locator('[data-testid="game-host-stage"]');
  await expect(stage).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  const log = tv.frameLocator('iframe[title="Input Lab"]').locator('[data-testid="log"]');
  return { tv, alex, bea, log, slug };
}

async function logLines(log: ReturnType<Page['locator']>) {
  const text = (await log.textContent()) ?? '';
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const { control, action, value } = JSON.parse(line) as {
        control: string;
        action: string;
        value: Record<string, unknown>;
      };
      return { control, action, value };
    });
}

test('stick and d-pad send directions and always end with a release', async ({ browser }) => {
  test.setTimeout(120_000);
  const { tv, alex, bea, log } = await startInputLab(browser);

  // Landscape hint: stick + d-pad in the left zone, FIRE in the right zone.
  await expect(alex.locator('.generic-zone-left [data-control="move"]')).toBeVisible();
  await expect(alex.locator('.generic-zone-left [data-control="aim"]')).toBeVisible();
  await expect(alex.locator('.generic-zone-right').getByRole('button', { name: 'FIRE' })).toBeVisible();

  await alex.screenshot({ path: test.info().outputPath('landscape-controller.png') });

  // Push the stick to the right, then let go.
  const stick = alex.locator('[data-control="move"]');
  const box = (await stick.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await alex.mouse.move(cx, cy);
  await alex.mouse.down();
  await alex.mouse.move(cx + box.width / 2, cy, { steps: 6 });
  await alex.waitForTimeout(150);
  await alex.mouse.up();

  await expect
    .poll(async () => (await logLines(log)).filter((l) => l.control === 'move').at(-1), { timeout: 10_000 })
    .toEqual({ control: 'move', action: 'release', value: { x: 0, y: 0 } });
  const moves = (await logLines(log)).filter((l) => l.control === 'move' && l.action === 'change');
  expect(moves.length).toBeGreaterThan(0);
  expect(Number(moves.at(-1)!.value.x)).toBeGreaterThan(0.8);

  // Press the d-pad's top arm, then let go.
  const pad = alex.locator('[data-control="aim"]');
  const padBox = (await pad.boundingBox())!;
  await alex.mouse.move(padBox.x + padBox.width / 2, padBox.y + 8);
  await alex.mouse.down();
  await expect(pad).toHaveAttribute('data-dir', 'up');
  await alex.mouse.up();

  await expect
    .poll(async () => (await logLines(log)).filter((l) => l.control === 'aim').map((l) => [l.action, l.value.dir]), {
      timeout: 10_000
    })
    .toEqual([
      ['change', 'up'],
      ['release', 'none']
    ]);

  await tv.close();
  await alex.close();
  await bea.close();
});

test('a held button is released when the phone is backgrounded', async ({ browser }) => {
  test.setTimeout(120_000);
  const { tv, alex, bea, log } = await startInputLab(browser);

  const fire = alex.getByRole('button', { name: 'FIRE' });
  const box = (await fire.boundingBox())!;
  await alex.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await alex.mouse.down();
  await expect.poll(async () => (await logLines(log)).filter((l) => l.control === 'fire').length).toBe(1);

  // The phone locks mid-press: no pointerup ever arrives.
  await alex.evaluate(() => window.dispatchEvent(new Event('blur')));

  await expect
    .poll(async () => (await logLines(log)).filter((l) => l.control === 'fire').map((l) => l.action), { timeout: 10_000 })
    .toEqual(['press', 'release']);

  await tv.close();
  await alex.close();
  await bea.close();
});

// Dispatch a touch pointer event with an explicit pointerId on a control.
async function touch(page: Page, selector: string, type: string, pointerId: number, x: number, y: number) {
  await page.evaluate(
    ({ selector, type, pointerId, x, y }) => {
      const el = document.querySelector(selector)!;
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: pointerId === 1,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y
        })
      );
    },
    { selector, type, pointerId, x, y }
  );
}

test('a second finger on the stick or d-pad neither moves nor releases it', async ({ browser }) => {
  test.setTimeout(120_000);
  const { tv, alex, bea, log } = await startInputLab(browser);

  const stickSel = '[data-control="move"]';
  const box = (await alex.locator(stickSel).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // Finger 1 grabs the stick; finger 2 lands on its left edge and lifts again.
  await touch(alex, stickSel, 'pointerdown', 1, cx, cy);
  await touch(alex, stickSel, 'pointerdown', 2, box.x, cy);
  await touch(alex, stickSel, 'pointermove', 2, box.x, cy);
  await touch(alex, stickSel, 'pointerup', 2, box.x, cy);
  // Finger 1 still steers: push right.
  await touch(alex, stickSel, 'pointermove', 1, box.x + box.width, cy);
  await expect
    .poll(async () => (await logLines(log)).filter((l) => l.control === 'move').map((l) => [l.action, l.value.x]), {
      timeout: 10_000
    })
    .toEqual([['change', 1]]);
  await touch(alex, stickSel, 'pointerup', 1, box.x + box.width, cy);
  await expect
    .poll(async () => (await logLines(log)).filter((l) => l.control === 'move').map((l) => [l.action, l.value.x]), {
      timeout: 10_000
    })
    .toEqual([
      ['change', 1],
      ['release', 0]
    ]);

  const padSel = '[data-control="aim"]';
  const padBox = (await alex.locator(padSel).boundingBox())!;
  const px = padBox.x + padBox.width / 2;
  await touch(alex, padSel, 'pointerdown', 3, px, padBox.y + 8);
  await expect(alex.locator(padSel)).toHaveAttribute('data-dir', 'up');
  await touch(alex, padSel, 'pointerdown', 4, px, padBox.y + padBox.height - 8);
  await touch(alex, padSel, 'pointerup', 4, px, padBox.y + padBox.height - 8);
  await expect(alex.locator(padSel)).toHaveAttribute('data-dir', 'up');
  await touch(alex, padSel, 'pointerup', 3, px, padBox.y + 8);
  await expect
    .poll(async () => (await logLines(log)).filter((l) => l.control === 'aim').map((l) => [l.action, l.value.dir]), {
      timeout: 10_000
    })
    .toEqual([
      ['change', 'up'],
      ['release', 'none']
    ]);

  await tv.close();
  await alex.close();
  await bea.close();
});

test('a rate-limited d-pad change is resent while the direction is held', async ({ browser }) => {
  test.setTimeout(120_000);
  let droppedOnce = false;
  const { tv, alex, bea, log } = await startInputLab(browser, async (page) => {
    // Answer the first d-pad change with the server's rate-limit ack instead of
    // relaying it, exactly as if the lobby budget had been spent.
    await page.routeWebSocket(/socket\.io/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const packet = typeof message === 'string' ? /^42(\d+)(\[.*)$/s.exec(message) : null;
        if (packet && !droppedOnce) {
          const [name, payload] = JSON.parse(packet[2]) as [string, { event?: { control?: string; value?: { action?: string } } }];
          if (name === 'controller:event' && payload.event?.control === 'aim' && payload.event.value?.action === 'change') {
            droppedOnce = true;
            ws.send(`43${packet[1]}[{"ok":true,"dropped":true}]`);
            return;
          }
        }
        server.send(message);
      });
    });
  });

  const pad = alex.locator('[data-control="aim"]');
  const padBox = (await pad.boundingBox())!;
  await alex.mouse.move(padBox.x + padBox.width / 2, padBox.y + 8);
  await alex.mouse.down();
  await expect(pad).toHaveAttribute('data-dir', 'up');
  // Still holding: the dropped change arrives via the resend.
  await expect
    .poll(async () => (await logLines(log)).filter((l) => l.control === 'aim').map((l) => [l.action, l.value.dir]), {
      timeout: 10_000
    })
    .toEqual([['change', 'up']]);
  expect(droppedOnce).toBe(true);
  await alex.mouse.up();
  await expect
    .poll(async () => (await logLines(log)).filter((l) => l.control === 'aim').map((l) => [l.action, l.value.dir]), {
      timeout: 10_000
    })
    .toEqual([
      ['change', 'up'],
      ['release', 'none']
    ]);

  await tv.close();
  await alex.close();
  await bea.close();
});
