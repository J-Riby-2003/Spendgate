import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  // one worker: the suites share the real server's approval queue, so the two
  // approval-flow tests would race each other in parallel
  workers: 1,
  // tests run against the production build served by the API on :8787
  // (npm run build -w web first — see the test:e2e script)
  use: { baseURL: 'http://localhost:8787' },
  webServer: [
    {
      command: 'npm run dev -w server',
      url: 'http://localhost:8787/api/state',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
