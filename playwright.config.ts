import { defineConfig, devices } from '@playwright/test';

const liveBaseURL = process.env.PLAYWRIGHT_BASE_URL;

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
          timeout: 60_000
        },
        {
          command: 'pnpm --filter @couch/web dev -- --host 127.0.0.1',
          url: 'http://127.0.0.1:5173',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000
        }
      ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ]
});
