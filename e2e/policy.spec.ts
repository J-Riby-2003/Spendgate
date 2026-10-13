import { expect, test } from '@playwright/test';
import { BASE, operatorHeaders, signIn, agentHeaders } from './helpers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('previews unsaved policy, compares real context, saves a revision and displays original decision evidence', async ({ page }) => {
  const headers = { ...await operatorHeaders(), 'Content-Type': 'application/json' };
  const agentId = 'policy-browser';
  expect((await fetch(`${BASE}/api/agents`, { method: 'POST', headers, body: JSON.stringify({ agentId, currency: 'GBP' }) })).status).toBe(201);
  await signIn(page); await page.getByRole('button', { name: 'Agents & Policy', exact: true }).click();
  const card = page.getByRole('region', { name: `Policy for ${agentId}`, exact: true });
  await card.getByRole('button', { name: 'New vendors need my yes' }).click();
  await card.getByRole('button', { name: 'Policy preview', exact: true }).click();
  await card.getByLabel('Sample amount (GBP)').fill('10.00');
  await card.getByLabel('Sample vendor').fill('acme');
  await card.getByRole('button', { name: 'Evaluate sample', exact: true }).click();
  await expect(card.getByTestId('policy-preview-result')).toContainText('Allow');
  await expect(card.getByTestId('policy-preview-result')).toContainText('Within all policy limits.');
  await card.getByRole('button', { name: 'Save policy', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Saved — applies to the next intent', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved — applies to the next intent', { exact: true })).toBeHidden();
  const client = new Client({ name: 'policy-browser', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: await agentHeaders(agentId) } }));
  try {
    expect((await client.callTool({ name: 'spend', arguments: { amount: 1000, currency: 'GBP', vendor: 'acme', purpose: 'Evidence browser test', deferred: true } })).isError).not.toBe(true);
  } finally { await client.close(); }
  await card.getByLabel('Blocked vendors').fill('acme');
  await card.getByRole('button', { name: 'Evaluate sample', exact: true }).click();
  await expect(card.getByTestId('policy-preview-result')).toContainText('Deny');
  await card.getByRole('button', { name: 'Compare recent requests', exact: true }).click();
  await expect(card.getByTestId('policy-replay-result')).toContainText('1 changed outcome');
  await expect(card.getByTestId('policy-replay-result')).toContainText('1 of 1 requests');
  await card.getByRole('button', { name: 'Policy history', exact: true }).click();
  await expect(card.getByTestId('policy-history')).toContainText('Version 2');
  await card.getByTestId('policy-history').getByText(/^Version 2/).click();
  await expect(card.getByTestId('policy-history')).toContainText('Allowed days: *');
  await page.screenshot({ path: 'test-results/policy-preview.png', fullPage: true });
  await page.getByRole('button', { name: 'Audit Ledger', exact: true }).click();
  await page.getByRole('cell', { name: 'acme (policy-browser)', exact: true }).click();
  await expect(page.getByText('Policy version: 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Original evaluation: Allow', { exact: true })).toBeVisible();
  await expect(page.getByText(/Evidence digest matches/)).toBeVisible();
});

test('stale policy edits show a conflict and reload explicitly', async ({ page }) => {
  const headers = { ...await operatorHeaders(), 'Content-Type': 'application/json' };
  await signIn(page); await page.getByRole('button', { name: 'Agents & Policy', exact: true }).click();
  const card = page.getByRole('region', { name: 'Policy for crawler-01', exact: true });
  await card.getByLabel('Blocked vendors').fill('draft-vendor');
  const state = await (await fetch(`${BASE}/api/state`, { headers })).json(), agent = state.agents.find((a: any) => a.agentId === 'crawler-01');
  expect((await fetch(`${BASE}/api/policies/crawler-01`, { method: 'PUT', headers, body: JSON.stringify({ ...agent.policy, expectedVersion: agent.policyVersion, blockedVendors: ['remote-vendor'] }) })).status).toBe(200);
  await expect(card.getByText(/Policy changed elsewhere/)).toBeVisible();
  await expect(card.getByLabel('Blocked vendors')).toHaveValue('draft-vendor');
  await card.getByRole('button', { name: 'Save policy', exact: true }).click(); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText(/Reload the current policy before comparing or saving/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await card.getByRole('button', { name: 'Reload current policy', exact: true }).click();
  await expect(card.getByLabel('Blocked vendors')).toHaveValue('remote-vendor');
});
