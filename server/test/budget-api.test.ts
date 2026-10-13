import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { once } from 'node:events';
vi.hoisted(() => { process.env.SPENDGATE_DATA = `/tmp/spendgate-budget-api-${Date.now()}-${Math.random()}`; });
import { createApplication } from '../src/app.js';
import { provisionOperator, issueCredential } from '../src/auth.js';
import { db, store } from '../src/core/store.js';
import { budget } from '../src/core/budget-state.js';
import { submitSpend } from '../src/core/engine.js';
import { seed } from '../src/seed.js';
import { appendLedger, verifyLedger } from '../src/core/ledger.js';
let server: ReturnType<typeof createApplication>, base: string, cookie: string, csrf: string, operatorId: string;
async function request(path: string, method = 'GET', body?: unknown, auth = true) {
  return fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(auth ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
beforeAll(async () => {
  operatorId = (await provisionOperator('operator', 'test budget password 123')).operatorId;
  server = createApplication(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.SPENDGATE_PUBLIC_BASE_URL = base;
  const login = await request('/api/auth/login', 'POST', { username: 'operator', password: 'test budget password 123' }, false);
  cookie = login.headers.get('set-cookie')!.split(';')[0]; csrf = (await login.json()).csrfToken;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
it('defaults new agents to hard-stop and preserves explicit mode when omitted from policy updates', async () => {
  expect((await request('/api/agents', 'POST', { agentId: 'budget-api', currency: 'GBP' })).status).toBe(201);
  expect(store.getPolicy('budget-api')?.budgetMode).toBe('hard-stop');
  const policy = { ...store.getPolicy('budget-api')!, dailyBudget: 100, maxPerTxn: null, newVendorRequiresApproval: false, budgetMode: 'approval-override' };
  expect((await request('/api/policies/budget-api', 'PUT', policy)).status).toBe(200);
  delete (policy as any).budgetMode;
  expect((await request('/api/policies/budget-api', 'PUT', policy)).status).toBe(200);
  expect(store.getPolicy('budget-api')?.budgetMode).toBe('approval-override');
  expect((await request('/api/policies/budget-api', 'PUT', { ...policy, budgetMode: 'anything' })).status).toBe(422);
});
it('prevents currency changes and deletion with outstanding permissions and rejects unsupported currencies', async () => {
  await submitSpend({ agentId: 'budget-api', amount: 50, currency: 'GBP', vendor: 'acme', purpose: 'hold', rail: 'mcp' });
  expect((await request('/api/agents/budget-api/currency', 'PATCH', { currency: 'USD' })).status).toBe(409);
  expect((await request('/api/agents/budget-api', 'DELETE', {})).status).toBe(409);
  expect(store.listAgents().find(a => a.agentId === 'budget-api')?.currency).toBe('GBP');
  expect((await request('/api/agents', 'POST', { agentId: 'bad-currency', currency: 'ZZZ' })).status).toBe(422);
  expect((await request('/api/agents', 'POST', { agentId: 'bad-type', currency: 12 })).status).toBe(422);
});
it('reports separate balance amounts and keeps seeded currency choices after restart', async () => {
  const state = await (await request('/api/state')).json();
  expect(state.agents.find((a: any) => a.agentId === 'budget-api')).toMatchObject({ spentToday: 0, budget: { currency: 'GBP', spentMinor: 0, reservedMinor: 50, remainingMinor: 50, timezone: 'UTC' } });
  expect((await request('/api/agents/finance-01/currency', 'PATCH', { currency: 'EUR' })).status).toBe(200);
  seed(); expect(store.listAgents().find(a => a.agentId === 'finance-01')?.currency).toBe('EUR');
});
it('offers operator-only legacy reconciliation with evidenced idempotent reviews and session attribution', async () => {
  const entry = appendLedger({ intent: { id: 'legacy-api', agentId: 'budget-api', amount: 20, currency: 'GBP', vendor: 'old-vendor', purpose: 'unknown', rail: 'mcp' }, decision: 'ALLOWED', rule: 'legacy', decidedBy: 'policy' });
  db.prepare('INSERT INTO legacy_budget_obligations (ledger_seq, agent_id) VALUES (?, ?)').run(entry.seq, 'budget-api');
  const path = '/api/agents/budget-api/budget/reconciliation';
  expect((await request(path, 'GET', undefined, false)).status).toBe(401);
  const credential = issueCredential('budget-api', operatorId);
  expect((await fetch(base + path, { headers: { Authorization: `Bearer ${credential.secret}` } })).status).toBe(401);
  const preview = await (await request(path)).json();
  expect(preview.obligations).toEqual(expect.arrayContaining([expect.objectContaining({ ledgerSeq: entry.seq, executionStatus: 'unknown', disposition: null })]));
  const review = { ledgerSeq: entry.seq, action: 'confirmed-paid', reason: 'Reviewed provider receipt', eventId: 'review-api', operatorId: 'forged' };
  expect((await request(path, 'POST', review)).status).toBe(422);
  expect((await request(path, 'POST', { ...review, evidence: 'receipt-42' })).status).toBe(200);
  expect((await request(path, 'POST', { ...review, evidence: 'receipt-42' })).status).toBe(200);
  expect(budget.legacyObligations('budget-api')[0].operatorId).toBe(operatorId);
  expect(budget.getBudgetSnapshot('budget-api').spentMinor).toBe(20);
  expect(verifyLedger().valid).toBe(true);
});
it('rolls back credential revocation and audit if guarded agent deletion fails', async () => {
  expect((await request('/api/agents', 'POST', { agentId: 'delete-atomic', currency: 'GBP' })).status).toBe(201);
  const c = issueCredential('delete-atomic', operatorId);
  db.exec(`CREATE TRIGGER reject_agent_delete BEFORE DELETE ON agents WHEN OLD.agent_id = 'delete-atomic' BEGIN SELECT RAISE(ABORT, 'simulated deletion failure'); END`);
  try {
    const before = db.prepare('SELECT COUNT(*) AS count FROM security_audit_events').get()!.count;
    expect((await request('/api/agents/delete-atomic', 'DELETE', {})).status).toBe(500);
    expect(db.prepare('SELECT revoked_at FROM agent_credentials WHERE id = ?').get(c.id)?.revoked_at).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM security_audit_events').get()!.count).toBe(before);
    expect(store.getPolicy('delete-atomic')).not.toBeNull();
  } finally { db.exec('DROP TRIGGER reject_agent_delete'); }
  expect((await request('/api/agents/delete-atomic', 'DELETE', {})).status).toBe(200);
  expect(db.prepare('SELECT revoked_at FROM agent_credentials WHERE id = ?').get(c.id)?.revoked_at).not.toBeNull();
});
it('reports a reconciliation conflict as 409 over MCP rather than a retryable server failure', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  await request('/api/agents', 'POST', { agentId: 'mcp-gated', currency: 'GBP' });
  const entry = appendLedger({ intent: { id: 'legacy-mcp', agentId: 'mcp-gated', amount: 20, currency: 'GBP', vendor: 'old-vendor', purpose: 'unknown', rail: 'mcp' }, decision: 'ALLOWED', rule: 'legacy', decidedBy: 'policy' });
  db.prepare('INSERT INTO legacy_budget_obligations (ledger_seq, agent_id) VALUES (?, ?)').run(entry.seq, entry.agentId);
  const credential = issueCredential('mcp-gated', operatorId), client = new Client({ name: 'budget-status-errors', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${credential.secret}` } } }));
  try {
    const result = await client.callTool({ name: 'spend', arguments: { amount: 10, currency: 'GBP', vendor: 'vendor', purpose: 'gate' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('error (409)');
  } finally { await client.close(); }
});
