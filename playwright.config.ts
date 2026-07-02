import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const liveBaseURL = process.env.PLAYWRIGHT_BASE_URL;

// The Wave-2D external-game e2e slice: hand-register the "tap-race" fixture
// game (served by apps/web/tests/fixtures/serve-fixture.mjs on :4180) with the
// realtime server via EXTERNAL_GAMES_JSON. Read the fixture's own manifest
// (creator-shaped, see apps/realtime/src/external-games.ts) instead of
// duplicating it here — it's the single source of truth for the fixture.
const tapRaceManifestPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'apps/web/tests/fixtures/tap-race/couch.game.json'
);
const tapRaceManifest = JSON.parse(readFileSync(tapRaceManifestPath, 'utf-8'));

export default defineConfig({
  testDir: './apps/web/tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // The suite boots multiple Phaser/WebGL canvases; cap workers so concurrent GL
  // contexts don't starve each other and flake on canvas-mount timing.
  workers: 3,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: liveBaseURL ?? 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  webServer: liveBaseURL
    ? undefined
    : [
        {
          command: 'pnpm build:packages && pnpm --filter @couch/realtime dev',
          url: 'http://127.0.0.1:4100/health',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          env: {
            ...(Object.fromEntries(
              Object.entries(process.env).filter(([, v]) => v !== undefined)
            ) as Record<string, string>),
            EXTERNAL_GAMES_JSON: JSON.stringify([tapRaceManifest])
          }
        },
        {
          command: 'pnpm --filter @couch/web dev -- --host 127.0.0.1',
          url: 'http://127.0.0.1:5173',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000
        },
        {
          command: 'node apps/web/tests/fixtures/serve-fixture.mjs',
          url: 'http://127.0.0.1:4180/tap-race/couch.game.json',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000
        }
      ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ]
});
