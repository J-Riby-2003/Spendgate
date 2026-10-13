import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Never reuse the live checkout's server, credentials, data or approval queue.
process.env.SPENDGATE_DATA ??= mkdtempSync(join(tmpdir(), 'spendgate-e2e-'));
const port = process.env.SPENDGATE_E2E_PORT ?? '18871';
const base = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './e2e', globalSetup: './e2e/setup.ts', timeout: 45_000, workers: 1,
  use: { baseURL: base },
  webServer: {
    command: 'npm run start -w server', url: `${base}/healthz`, reuseExistingServer: false, timeout: 30_000,
    env: { SPENDGATE_DATA: process.env.SPENDGATE_DATA, SPENDGATE_PORT: port, SPENDGATE_PUBLIC_BASE_URL: base, NODE_ENV: 'test', SPENDGATE_TELEGRAM_BOT_TOKEN: '', SPENDGATE_TELEGRAM_CHAT_ID: '' },
  },
});
