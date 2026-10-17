import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Never reuse the live checkout's server, credentials, data or approval queue.
process.env.SPENDLOCK_DATA ??= mkdtempSync(join(tmpdir(), 'spendlock-e2e-'));
const port = process.env.SPENDLOCK_E2E_PORT ?? '18871';
const base = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './e2e', globalSetup: './e2e/setup.ts', timeout: 45_000, workers: 1,
  use: { baseURL: base },
  webServer: {
    command: 'npm run start -w server', url: `${base}/healthz`, reuseExistingServer: false, timeout: 30_000,
    env: { SPENDLOCK_DATA: process.env.SPENDLOCK_DATA, SPENDLOCK_PORT: port, SPENDLOCK_PUBLIC_BASE_URL: base, NODE_ENV: 'test', SPENDLOCK_TELEGRAM_BOT_TOKEN: '', SPENDLOCK_TELEGRAM_CHAT_ID: '' },
  },
});
