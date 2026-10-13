import { expect, test } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let child: ChildProcess, base: string, data: string;
test.beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), 'spendgate-onboarding-browser-'));
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, SPENDGATE_DATA: data, SPENDGATE_PORT: String(port), SPENDGATE_PUBLIC_BASE_URL: base,
    SPENDGATE_SEED_DEMO: 'false', SPENDGATE_TELEGRAM_BOT_TOKEN: '', SPENDGATE_TELEGRAM_CHAT_ID: '', NODE_ENV: 'test' };
  execFileSync(process.execPath, ['--import', 'tsx', 'server/src/provision-operator.ts', 'test-operator'], { env, input: 'isolated test operator password\n', stdio: ['pipe','pipe','pipe'] });
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: join(process.cwd(), 'server'), env, stdio: 'pipe' });
  await expect.poll(async () => { try { return (await fetch(base + '/healthz')).status; } catch { return 0; } }).toBe(200);
});
test.afterEach(async () => {
  if (child && child.exitCode === null) { child.kill(); await new Promise<void>(resolve => child.once('exit', () => resolve())); }
  if (data) rmSync(data, { recursive: true, force: true });
});
async function login(page: import('@playwright/test').Page) {
  await page.goto(base);
  await page.getByLabel('Username', { exact: true }).fill('test-operator');
  await page.getByLabel('Password', { exact: true }).fill('isolated test operator password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function connect(secret: string, challenge: string) {
  const client = new Client({ name: 'onboarding-browser-client', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
    return await client.callTool({ name: 'connection_check', arguments: { challenge } });
  } finally { await client.close(); }
}
test('clean account guides creation, failed connection retry, safe tests and completion', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Set up an agent', exact: true }).click();
  await page.getByLabel('Agent id', { exact: true }).fill('browser-onboarding');
  await page.getByLabel('Display name', { exact: true }).fill('Browser agent');
  await page.getByRole('button', { name: 'Continue to policy' }).click();
  await page.getByLabel('Daily budget', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Create agent and policy' }).click();
  await page.getByRole('button', { name: 'Create credential', exact: true }).click();
  const secret = await page.getByLabel('New agent credential', { exact: true }).inputValue();
  expect(secret).toHaveLength(43);
  await page.getByRole('button', { name: 'I have saved the credential' }).click();
  await expect(page.getByLabel('Claude Code configuration')).toContainText('${SPENDGATE_AGENT_TOKEN}');
  await page.getByRole('button', { name: 'Get connection challenge' }).click();
  await page.getByRole('button', { name: 'Check connection status' }).click();
  await expect(page.getByRole('alert')).toContainText('No MCP client has verified');
  const challenge = await page.getByLabel('Connection challenge', { exact: true }).inputValue();
  expect((await connect(secret, 'wrong-challenge')).isError).toBe(true);
  expect((await connect(secret, challenge)).isError).not.toBe(true);
  await page.getByRole('button', { name: 'Check connection status' }).click();
  await expect(page.getByText('MCP connection verified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to safe tests' }).click();
  await page.getByRole('button', { name: 'Run safe tests' }).click();
  await expect(page.getByText('Illustrative allow policy', { exact: true })).toBeVisible();
  await expect(page.getByText('Illustrative approval policy', { exact: true })).toBeVisible();
  await expect(page.getByText('Illustrative denial policy', { exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/spendgate-onboarding-safe-tests.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Set up an agent', exact: true }).click();
  await expect(page.getByText('Safe tests completed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(page.getByText('Agent setup complete', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Audit Ledger', exact: true }).click();
  await expect(page.getByText('Ledger is empty.', { exact: true })).toBeVisible();
  const session = await (await page.request.get(base + '/api/auth/session')).json();
  const credentials = await (await page.request.get(base + '/api/agents/browser-onboarding/credentials')).json();
  expect((await page.request.delete(base + `/api/agents/browser-onboarding/credentials/${credentials[0].id}`, { headers: { Origin: base, 'X-CSRF-Token': session.csrfToken } })).status()).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: 'Set up an agent', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('no longer active');
  await page.getByRole('button', { name: 'Start another agent', exact: true }).click();
  await expect(page.getByLabel('Agent id', { exact: true })).toHaveValue('');
});
test('deleted unfinished agent can be abandoned and setup restarted without reusing its identity', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Set up an agent', exact: true }).click();
  await page.getByLabel('Agent id', { exact: true }).fill('deleted-onboarding');
  await page.getByRole('button', { name: 'Continue to policy' }).click();
  await page.getByRole('button', { name: 'Create agent and policy' }).click();
  await expect(page.getByRole('button', { name: 'Create credential', exact: true })).toBeVisible();
  const session = await (await page.request.get(base + '/api/auth/session')).json();
  expect((await page.request.delete(base + '/api/agents/deleted-onboarding', { headers: { Origin: base, 'X-CSRF-Token': session.csrfToken } })).status()).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: 'Set up an agent', exact: true }).click();
  await page.getByRole('button', { name: 'Abandon setup and restart', exact: true }).click();
  await expect(page.getByLabel('Agent id', { exact: true })).toHaveValue('');
});
test('refresh resumes setup without secrets and offers explicit credential rotation recovery', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Set up an agent', exact: true }).click();
  await page.getByLabel('Agent id', { exact: true }).fill('resume-onboarding');
  await page.getByRole('button', { name: 'Continue to policy' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Set up an agent', exact: true }).click();
  await expect(page.getByLabel('Agent id', { exact: true })).toHaveValue('resume-onboarding');
  await page.getByRole('button', { name: 'Continue to policy' }).click();
  await page.getByRole('button', { name: 'Create agent and policy' }).click();
  await page.getByRole('button', { name: 'Create credential', exact: true }).click();
  const old = await page.getByLabel('New agent credential', { exact: true }).inputValue();
  await page.reload();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Set up an agent', exact: true }).click();
  await expect(page.getByLabel('New agent credential', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Rotate credential to recover', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // Drop the response after the server commits rotation. Retrying the same
  // confirmation must not rotate the newly issued replacement again.
  let drop = true;
  await page.route('**/credentials/*/rotate', async route => {
    if (drop) { drop = false; await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Rotate now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rotate now', exact: true })).toBeEnabled();
  const committed = await (await page.request.get(base + '/api/agents/resume-onboarding/credentials')).json();
  expect(committed).toHaveLength(2);
  await page.getByRole('button', { name: 'Rotate now', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await (await page.request.get(base + '/api/agents/resume-onboarding/credentials')).json()).toHaveLength(2);
  await expect(page.getByLabel('New agent credential', { exact: true })).toHaveCount(0);
  // An explicit new recovery action rotates the replacement whose response was lost.
  await page.getByRole('button', { name: 'Rotate credential to recover', exact: true }).click();
  await page.getByRole('button', { name: 'Rotate now', exact: true }).click();
  await expect(page.getByLabel('New agent credential', { exact: true })).not.toHaveValue(old);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(old);
});
