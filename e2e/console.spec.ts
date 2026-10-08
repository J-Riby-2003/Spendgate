// End-to-end: the console as a human actually uses it — locked gate, token
// unlock, and a full agent-escalation → human-approval cycle (the product's
// core loop) driven through the real UI against the real server.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKEN = readFileSync(new URL('../.spendgate/console.token', import.meta.url), 'utf8').trim();
const AUTH = { Authorization: `Bearer ${TOKEN}` };

async function unlock(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByLabel('Console token').fill(TOKEN);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('aside')).toBeVisible();
}

test('token gate blocks the console until unlocked', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Console token')).toBeVisible();
  await expect(page.locator('aside')).toBeHidden();
  // read-only promise: no way past the gate without the token
  await expect(page.getByText('Console is read-only.')).toBeVisible();
});

test('unlocking with the console token opens the console', async ({ page }) => {
  await unlock(page);
  await expect(page.getByRole('button', { name: 'Approvals' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Agents' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ledger' })).toBeVisible();
});

test('agent escalation is approved by a human in the console', async ({ page }) => {
  await unlock(page);

  // an agent spends over its human-approval threshold over real MCP —
  // the call blocks until a human decides, exactly as in production
  const client = new Client({ name: 'spendgate-e2e-agent', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8787/mcp'), {
    requestInit: { headers: AUTH },
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

  // the queue is drained again (Recent decisions does not repeat the purpose text)
  await expect(page.getByText('No pending escalations.')).toBeVisible();
});
