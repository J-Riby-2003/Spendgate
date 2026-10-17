import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { once } from 'node:events';
vi.hoisted(() => { process.env.TOLLKEEP_DATA = `/tmp/tollkeep-policy-api-${Date.now()}-${Math.random()}`; });
import { createApplication } from '../src/app.js';
import { provisionOperator, issueCredential } from '../src/auth.js';
import { db, store } from '../src/core/store.js';
import { submitRequest } from '../src/core/engine.js';
let server: ReturnType<typeof createApplication>, base: string, cookie: string, csrf: string, operatorId: string;
async function request(path: string, method = 'GET', body?: unknown, auth = true) {
  return fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(auth ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
beforeAll(async () => {
  operatorId = (await provisionOperator('operator', 'test policy password 123')).operatorId;
  server = createApplication(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`; process.env.TOLLKEEP_PUBLIC_BASE_URL = base;
  const login = await request('/api/auth/login', 'POST', { username: 'operator', password: 'test policy password 123' }, false);
  cookie = login.headers.get('set-cookie')!.split(';')[0]; csrf = (await login.json()).csrfToken;
  expect((await request('/api/agents', 'POST', { agentId: 'policy-api', currency: 'GBP' })).status).toBe(201);
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
it('protects simulation/history/evidence with operator sessions and CSRF, denying agent credentials', async () => {
  const paths = ['/api/policies/policy-api/history', '/api/requests/missing/evidence'];
  const credential = issueCredential('policy-api', operatorId);
  for (const path of paths) {
    expect((await request(path, 'GET', undefined, false)).status).toBe(401);
    expect((await fetch(base + path, { headers: { Authorization: `Bearer ${credential.secret}` } })).status).toBe(401);
  }
  expect((await fetch(base + '/api/policies/policy-api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: '{}' })).status).toBe(403);
});
it('previews unsaved changes with exact reasons and creates no production rows, even with forged metadata', async () => {
  const sample = { amount: 10, currency: 'GBP', vendor: 'blocked', purpose: 'test', rail: 'mcp', evidence: { digest: 'forged' } };
  const policy = { ...store.getPolicy('policy-api')!, blockedVendors: ['blocked'] };
  const count = () => JSON.stringify(['spend_requests','policy_evidence','ledger','approvals','budget_reservations','notification_outbox'].map(t => db.prepare(`SELECT COUNT(*) FROM ${t}`).get()));
  const before = count();
  const response = await request('/api/policies/policy-api/preview', 'POST', { policy, sample });
  expect(response.status).toBe(200);
  expect((await response.json()).verdict).toEqual({ decision: 'DENY', rule: 'vendor-blocked', reason: '"blocked" is on this agent\'s blocklist.' });
  expect(count()).toBe(before);
  expect((await request('/api/policies/policy-api/preview', 'POST', { policy, sample: { ...sample, currency: 'USD' } })).status).toBe(422);
});
it('requires expectedVersion, saves authenticated before/after and rejects racing stale saves', async () => {
  const path = '/api/policies/policy-api', policy = store.getPolicy('policy-api')!;
  expect((await request(path, 'PUT', policy)).status).toBe(422);
  const expectedVersion = store.getPolicyVersion('policy-api');
  const responses = await Promise.all([request(path, 'PUT', { ...policy, expectedVersion, maxPerTxn: 100, changedBy: 'forged' }), request(path, 'PUT', { ...policy, expectedVersion, maxPerTxn: 200 })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  const history = await (await request(path + '/history')).json();
  expect(history.revisions[0]).toMatchObject({ changedBy: operatorId, before: policy, source: 'operator' });
  expect(history.revisions[0].after.allowedDays).toBe('*');
  expect(history.revisions.at(-1)).toMatchObject({ changedBy: operatorId, before: null });
});
it('returns bounded replay, original evidence and version in state; rejects stale comparisons and malformed limits', async () => {
  const policy = store.getPolicy('policy-api')!, version = store.getPolicyVersion('policy-api');
  const real = submitRequest({ agentId: 'policy-api', amount: 10, currency: 'GBP', vendor: 'new', purpose: 'replay', rail: 'mcp' });
  const evidence = await (await request(`/api/requests/${real.requestId}/evidence`)).json();
  expect(evidence).toMatchObject({ integrity: 'verified', envelope: { policyVersion: version, verdict: { decision: 'ESCALATE' } } });
  const replay = await request('/api/policies/policy-api/replay', 'POST', { policy: { ...policy, blockedVendors: ['new'] }, expectedVersion: version, limit: 1 });
  expect(replay.status).toBe(200); expect((await replay.json()).changedOutcomes).toBe(1);
  expect((await request('/api/policies/policy-api/replay', 'POST', { policy, expectedVersion: version - 1 })).status).toBe(409);
  for (const limit of [0, 501, '10', null]) expect((await request('/api/policies/policy-api/replay', 'POST', { policy, expectedVersion: version, limit })).status).toBe(422);
  expect((await (await request('/api/state')).json()).agents.find((a: any) => a.agentId === 'policy-api').policyVersion).toBe(version);
  expect((await request('/api/requests/missing/evidence')).status).toBe(404);
});
