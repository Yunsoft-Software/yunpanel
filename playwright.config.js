import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  workers: 1,
  expect: {
    timeout: 10000,
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://server.cryptoraichu.website',
    ignoreHTTPSErrors: true,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    // Playwright's own Chromium, never the installed Google Chrome: a headless Chrome
    // keeps the app "running" on macOS and the user's Chrome window will not open.
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
      },
    },
  ],
});
