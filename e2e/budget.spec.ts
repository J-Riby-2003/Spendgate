import { expect, test } from '@playwright/test';
import { BASE, agentHeaders, operatorHeaders, signIn } from './helpers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('operator selects a budget mode and sees permission reserved separately from completed spend', async ({ page }) => {
  const headers = { ...await operatorHeaders(), 'Content-Type': 'application/json' };
  const agentId = 'budget-browser';
  expect((await fetch(`${BASE}/api/agents`, { method: 'POST', headers, body: JSON.stringify({ agentId, currency: 'GBP' }) })).status).toBe(201);
  await signIn(page); await page.getByRole('button', { name: 'Agents & Policy', exact: true }).click();
  const card = page.getByRole('region', { name: 'Policy for budget-browser' });
  await expect(card.getByLabel('Budget mode')).toHaveValue('hard-stop');
  await card.getByLabel('Budget mode').selectOption('approval-override');
  await card.getByRole('button', { name: 'Save policy' }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Saved — applies to the next intent', { exact: true })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Agents & Policy', exact: true }).click();
  await expect(card.getByLabel('Budget mode')).toHaveValue('approval-override');
  // Keep request in the automatic path for this balance test.
  const state = await (await fetch(`${BASE}/api/state`, { headers })).json();
  const policy = state.agents.find((a: any) => a.agentId === agentId).policy;
  await fetch(`${BASE}/api/policies/${agentId}`, { method: 'PUT', headers, body: JSON.stringify({ ...policy, expectedVersion: state.agents.find((a: any) => a.agentId === agentId).policyVersion, newVendorRequiresApproval: false, allowedDays: '*' }) });
  const client = new Client({ name: 'budget-browser', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: await agentHeaders(agentId) } }));
  try {
    const result = await client.callTool({ name: 'spend', arguments: { amount: 1234, currency: 'GBP', vendor: 'acme', purpose: 'authorisation only' } });
    expect(result.isError).not.toBe(true);
    await expect(card.getByTestId('budget-spent')).toHaveText('£0.00');
    await expect(card.getByTestId('budget-reserved')).toHaveText('£12.34');
    await expect(card.getByTestId('budget-remaining')).toHaveText('£487.66');
    await expect(card.getByText('Daily period: UTC')).toBeVisible();
    const status = await client.callTool({ name: 'budget_status', arguments: {} });
    expect(JSON.stringify(status)).toContain('Reserved: £12.34');
    await page.screenshot({ path: 'test-results/budget-balances.png', fullPage: true });
  } finally { await client.close(); }
});

test('legacy review attests no outstanding obligation while leaving payment status unknown', async ({ page }) => {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['--import', 'tsx', 'server/test/fixtures/legacy-browser.ts'], { cwd: process.cwd(), env: process.env, stdio: 'pipe' });
  await signIn(page); await page.getByRole('button', { name: 'Agents & Policy', exact: true }).click();
  const card = page.getByRole('region', { name: 'Policy for legacy-browser' });
  await expect(card.getByText(/New authorisations are paused/)).toBeVisible();
  await card.getByRole('button', { name: 'Review legacy obligations' }).click();
  const obligation = card.getByRole('region', { name: /Legacy obligation/ });
  await expect(obligation.getByText(/Payment status: unknown/)).toBeVisible();
  await obligation.getByLabel('Review reason').fill('Reviewed provider records: no outstanding obligation');
  await obligation.getByRole('button', { name: 'Record reconciliation' }).click();
  await expect(page.getByText(/This attests no outstanding obligation; historical payment remains unknown/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(card.getByText(/New authorisations are paused/)).toHaveCount(0);
  await expect(obligation.getByText(/Payment status: unknown.*Disposition: no-outstanding-obligation/)).toBeVisible();
  await expect(card.getByTestId('budget-spent')).toHaveText('£0.00');
  await expect(card.getByTestId('budget-reserved')).toHaveText('£0.00');
  await expect(card.getByTestId('budget-remaining')).toHaveText('£100.00');
  await page.screenshot({ path: 'test-results/budget-reconciliation.png', fullPage: true });
});
