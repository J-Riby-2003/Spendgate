import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Never reuse the live checkout's server, credentials, data or approval queue.
process.env.TOLLKEEP_DATA ??= mkdtempSync(join(tmpdir(), 'tollkeep-e2e-'));
const port = process.env.TOLLKEEP_E2E_PORT ?? '18871';
const base = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './e2e', globalSetup: './e2e/setup.ts', timeout: 45_000, workers: 1,
  use: { baseURL: base },
  webServer: {
    command: 'npm run start -w server', url: `${base}/healthz`, reuseExistingServer: false, timeout: 30_000,
    env: { TOLLKEEP_DATA: process.env.TOLLKEEP_DATA, TOLLKEEP_PORT: port, TOLLKEEP_PUBLIC_BASE_URL: base, NODE_ENV: 'test', TOLLKEEP_TELEGRAM_BOT_TOKEN: '', TOLLKEEP_TELEGRAM_CHAT_ID: '' },
  },
});
