import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  workers: 1,
  reporter: [[process.env.CI ? 'dot' : 'list'], ['./e2e/redacting-reporter.js']],
  expect: {
    timeout: 10000,
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://server.cryptoraichu.website',
    ignoreHTTPSErrors: true,
    headless: true,
    screenshot: 'only-on-failure',
    // A trace records typed values and request bodies, including the owner password, and its
    // archive cannot be redacted. Turn it on only for local debugging: PW_TRACE=1 (T827).
    trace: process.env.PW_TRACE === '1' ? 'retain-on-failure' : 'off',
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
