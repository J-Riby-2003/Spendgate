// End-to-end: the console as a human actually uses it — locked gate, token
// unlock, and a full agent-escalation → human-approval cycle (the product's
// core loop) driven through the real UI against the real server.
import { expect, test } from '@playwright/test';
import { BASE, agentHeaders, signIn } from './helpers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('sign-in gate blocks the console until authenticated', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await expect(page.locator('aside')).toBeHidden();
  // read-only promise: no way past the gate without the token
  expect((await page.request.get('/api/state')).status()).toBe(401);
});

test('signing in opens the console and logout invalidates access', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Approvals' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Agents' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Audit Ledger', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  expect((await page.request.get('/api/state')).status()).toBe(401);
});

test('agent escalation is approved by a human in the console', async ({ page }) => {
  await signIn(page);

  // an agent spends over its human-approval threshold over real MCP —
  // the call blocks until a human decides, exactly as in production
  const client = new Client({ name: 'tollkeep-e2e-agent', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: await agentHeaders('procurement-02') },
  });
  await client.connect(transport);
  const purpose = `E2E approval test ${Date.now()}`;
  const spendPromise = client.callTool({
    name: 'spend',
    arguments: {
      agent: 'procurement-02',
      amount: 21_400, // £214 — over procurement-02's £50 per-txn cap, escalates
      currency: 'GBP',
      vendor: 'paper-mill-co',
      purpose,
      rail: 'mcp',
    },
  });

  // the escalation appears in the queue; the human approves it
  await page.getByRole('button', { name: 'Approvals' }).click();
  const card = page.locator('div.rounded-lg', { hasText: purpose });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Approve' }).click();

  // the blocked agent call resolves APPROVED — the loop is closed
  const result = await spendPromise;
  const text = (result.content as { text: string }[])[0].text;
  expect(text.startsWith('APPROVED')).toBe(true);
  await client.close();

  // this escalation leaves the queue (other pending items may legitimately exist)
  await expect(page.locator('div.rounded-lg', { hasText: purpose })).toHaveCount(0);
});

test('invalid password stays locked and credential secrets are shown only on issuance', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('test-operator');
  await page.getByLabel('Password', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid username or password');
  await expect(page.locator('aside')).toBeHidden();
  await signIn(page);
  await page.getByRole('button', { name: 'Agents & Policy', exact: true }).click();
  const section = page.getByRole('region', { name: 'Credentials for procurement-02' });
  await section.getByRole('button', { name: 'Issue credential', exact: true }).click();
  await expect(section.getByLabel('New credential')).toBeVisible();
  const raw = await section.getByLabel('New credential').inputValue();
  expect(raw.length).toBe(43);
  await section.getByRole('button', { name: 'I have saved it' }).click();
  await expect(section.getByLabel('New credential')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Agents & Policy', exact: true }).click();
  await expect(section.getByLabel('New credential')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('sg-token'))).toBeNull();
  await page.screenshot({ path: 'test-results/agents-access.png', fullPage: true });
});
