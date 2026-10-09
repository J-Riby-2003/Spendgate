// E2E: the phone-approval loop. An agent escalation is decided through a
// public /decide/<token> link — no console token on the phone — and the
// blocked MCP call resolves, the link dies, and a retap shows the used state.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKEN = readFileSync(new URL('../.spendgate/console.token', import.meta.url), 'utf8').trim();
const AUTH = { Authorization: `Bearer ${TOKEN}` };

test('decision link approves an escalation from the phone page', async ({ page }) => {
  // an agent spends over its ceiling — the call blocks until a human decides
  const client = new Client({ name: 'spendgate-e2e-phone', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8787/mcp'), {
    requestInit: { headers: AUTH },
  });
  await client.connect(transport);
  const purpose = `E2E decide-link test ${Date.now()}`;
  const spendPromise = client.callTool({
    name: 'spend',
    arguments: {
      agent: 'procurement-02',
      amount: 21_400, // £214 — over procurement-02's £50 per-txn cap
      currency: 'GBP',
      vendor: 'paper-mill-co',
      purpose,
      rail: 'mcp',
    },
  });

  // the escalation lands in the queue
  let approval: { id: string } | undefined;
  for (let i = 0; i < 50 && !approval; i++) {
    const list = await fetch('http://localhost:8787/api/approvals').then((r) => r.json());
    approval = (list.pending as { id: string; intent: { purpose: string } }[]).find((a) => a.intent.purpose === purpose);
    if (!approval) await new Promise((r) => setTimeout(r, 200));
  }
  expect(approval).toBeDefined();

  // the operator mints a phone link (bearer-protected endpoint)
  const { links } = await fetch(`http://localhost:8787/api/approvals/${approval!.id}/links`, { headers: AUTH })
    .then((r) => r.json()) as { links: { action: string; path: string }[] };
  const approvePath = links.find((l) => l.action === 'approve')!.path;

  // the phone opens the public link — confirm tap executes the decision
  await page.goto(approvePath);
  await expect(page.getByText('Approve this payment?')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm approve' }).click();
  await expect(page.getByText('APPROVED')).toBeVisible();

  // the blocked agent call resolves with the same decision
  const result = await spendPromise;
  const text = (result.content as { text: string }[])[0].text;
  expect(text.startsWith('APPROVED')).toBe(true);
  await client.close();

  // a second tap on the spent link shows the used state, not a re-decision
  await page.reload();
  await expect(page.getByText('already been used')).toBeVisible();
});
