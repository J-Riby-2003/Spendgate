// Cross-feature contract: onboarding -> pure simulation -> real approval -> signed evidence.
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
vi.hoisted(() => {
  process.env.TOLLKEEP_DATA = `/tmp/tollkeep-adoption-integration-${Date.now()}-${Math.random()}`;
  process.env.TOLLKEEP_SEED_DEMO = 'false';
});
import { createApplication } from '../src/app.js';
import { provisionOperator } from '../src/auth.js';
import { store, db } from '../src/core/store.js';
import { verifyLedger } from '../src/core/ledger.js';
let server: ReturnType<typeof createApplication>, base: string, headers: Record<string, string>, operatorId: string;
async function request(path: string, method = 'GET', body?: unknown) {
  return fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(async () => {
  operatorId = (await provisionOperator('integration-operator', 'isolated integration password')).operatorId;
  server = createApplication(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`; process.env.TOLLKEEP_PUBLIC_BASE_URL = base;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'integration-operator', password: 'isolated integration password' }) });
  expect(login.status).toBe(200);
  headers = { Origin: base, 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie')!.split(';')[0], 'X-CSRF-Token': (await login.json()).csrfToken };
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
it('preserves scoped setup, zero-effect tests and original evidence through explicit override finalisation', async () => {
  const journey = await (await request('/api/onboarding', 'POST', { requestId: randomUUID() })).json();
  const agentId = 'integrated-agent', policy = { agentId, maxPerTxn: 50, dailyBudget: 100, approvalThreshold: null, budgetMode: 'approval-override', allowedVendors: '*', blockedVendors: [], newVendorRequiresApproval: false, allowedDays: '*', allowedWindow: null };
  const draft = { agentId, displayName: 'Integrated agent', currency: 'GBP', policy };
  const savedDraft = await (await request(`/api/onboarding/${journey.id}`, 'PATCH', { expectedRevision: journey.revision, draft })).json();
  const creation = { ...draft, onboardingId: journey.id, expectedRevision: savedDraft.revision };
  expect((await request('/api/agents', 'POST', creation)).status).toBe(201);
  expect((await request('/api/agents', 'POST', creation)).status).toBe(200);
  expect(store.policyHistory(agentId)).toHaveLength(1);
  expect(store.policyHistory(agentId)[0].changedBy).toBe(operatorId);
  const credentialPath = `/api/agents/${agentId}/credentials`;
  const credential = await (await request(credentialPath, 'POST', { onboardingId: journey.id })).json();
  const retry = await (await request(credentialPath, 'POST', { onboardingId: journey.id })).json();
  expect(retry).toMatchObject({ id: credential.id, secret: null });
  expect((await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${credential.secret}` } })).status).toBe(401);
  const client = new Client({ name: 'adoption-integration', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${credential.secret}` } } }));
  try {
    const challenge = await (await request(`/api/onboarding/${journey.id}/challenge`, 'POST', {})).json();
    expect((await client.callTool({ name: 'connection_check', arguments: { challenge: challenge.challenge } })).isError).not.toBe(true);
    const tables = ['ledger', 'approvals', 'spend_requests', 'budget_reservations', 'notification_outbox', 'idempotency_keys', 'policy_evidence', 'policy_revisions'];
    const monetaryState = () => JSON.stringify(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all()));
    const before = monetaryState();
    const sample = { amount: 60, currency: 'GBP', vendor: 'acme', purpose: 'Integration test', rail: 'mcp' };
    const simulated = await client.callTool({ name: 'onboarding_test', arguments: { onboardingId: journey.id, sample } });
    expect(simulated.isError).not.toBe(true); expect(monetaryState()).toBe(before);
    expect((await request(`/api/onboarding/${journey.id}/complete`, 'POST', {})).status).toBe(200);
    const first = (await client.callTool({ name: 'spend', arguments: { ...sample, deferred: true, idempotencyKey: 'first' } })).structuredContent as any;
    const second = (await client.callTool({ name: 'spend', arguments: { ...sample, deferred: true, idempotencyKey: 'second' } })).structuredContent as any;
    expect(first.decision).toBe('PENDING'); expect(second.decision).toBe('PENDING');
    const evidencePath = `/api/requests/${second.requestId}/evidence`;
    const evidence = await (await request(evidencePath)).json();
    expect(evidence).toMatchObject({ integrity: 'verified', envelope: { policyVersion: 1, context: { budget: { reservedMinor: 0 } }, verdict: { decision: 'ESCALATE' } } });
    expect((await request(`/api/approvals/${first.approvalId}/decide`, 'POST', { approve: true })).status).toBe(200);
    const context = await (await request(`/api/approvals/${second.approvalId}/context`)).json();
    expect(context.context.budget).toMatchObject({ overrideRequired: true, snapshot: { reservedMinor: 60 } });
    const decisionPath = `/api/approvals/${second.approvalId}/decide`;
    for (const consent of [undefined, false]) {
      const refused = await request(decisionPath, 'POST', { approve: true, note: 'Ordinary review note', overrideBudget: consent });
      expect(refused.status).toBe(409);
      expect((await refused.json()).code).toBe('approval-budget-conflict');
      expect(store.getApproval(second.approvalId)?.status).toBe('pending');
    }
    expect((await request(decisionPath, 'POST', { approve: true, overrideBudget: true })).status).toBe(422);
    expect((await request(decisionPath, 'POST', { approve: true, overrideBudget: true, note: 'Explicit operational exception' })).status).toBe(200);
    expect(await (await request(evidencePath)).json()).toEqual(evidence);
    const entry = store.fullLedger().find(e => e.intentId === second.requestId)!;
    expect(entry.details).toMatchObject({ actor: { kind: 'operator', id: operatorId }, evidence: { digest: evidence.digest }, budgetRecheck: { overrideConsent: true, overrideReason: 'Explicit operational exception' } });
    expect(verifyLedger().valid).toBe(true);
    const comparison = await (await request(`/api/policies/${agentId}/replay`, 'POST', { policy, expectedVersion: 1 })).json();
    expect(comparison.coverage).toEqual({ selected: 2, evaluated: 2, unavailable: 0 });
    expect(comparison.changedOutcomes).toBe(0);
    // Original snapshots had no holds. Substituting the live 120-unit hold would trigger over-daily-budget.
    for (const row of comparison.rows) {
      expect(row.current.rule).toBe('over-max-per-txn');
      expect(row.proposed.rule).toBe('over-max-per-txn');
    }
    expect((await client.callTool({ name: 'spend', arguments: { ...sample, deferred: true, idempotencyKey: 'second' } })).structuredContent).toMatchObject({ requestId: second.requestId, decision: 'APPROVED' });
  } finally { await client.close(); }
});
