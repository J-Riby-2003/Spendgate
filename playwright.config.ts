import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  use: { baseURL: 'http://localhost:7100' },
  // Reuses the dev servers when they're already running (the common case);
  // otherwise boots them itself.
  webServer: [
    {
      command: 'npm run dev -w server',
      url: 'http://localhost:8787/api/state',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run dev -w web',
      url: 'http://localhost:7100',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
