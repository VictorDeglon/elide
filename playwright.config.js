import { defineConfig } from '@playwright/test';

// One worker: every test launches its own Chromium with the extension loaded, and the
// timing assertions are about the extension, not about CPU contention between browsers.
export default defineConfig({
  testDir: 'test/e2e',
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  projects: [
    { name: 'harness', testMatch: /harness\.spec\.js/ },
    { name: 'popup', testMatch: /popup\.spec\.js/ },
    { name: 'network', testMatch: /network\.spec\.js/, timeout: 120_000 },
    { name: 'live', testMatch: /live\.spec\.js/, timeout: 240_000 }
  ]
});
