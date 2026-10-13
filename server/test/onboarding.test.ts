import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
vi.hoisted(() => {
  process.env.SPENDGATE_DATA = `/tmp/spendgate-onboarding-${Date.now()}-${Math.random()}`;
  process.env.SPENDGATE_SEED_DEMO = 'false';
});
import { createApplication } from '../src/app.js';
import { db, store } from '../src/core/store.js';
import { provisionOperator, authenticateAgent, revokeCredential, deleteAgentWithCredentials, issueCredential } from '../src/auth.js';
import { ownedJourney } from '../src/core/onboarding-store.js';
import * as simulation from '../src/core/simulation.js';
let server: ReturnType<typeof createApplication>, base: string, cookie: string, csrf: string, operatorId: string;
async function request(path: string, method = 'GET', body?: unknown, auth = true) {
  return fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base,
    ...(auth ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function startServer() {
  server = createApplication(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`; process.env.SPENDGATE_PUBLIC_BASE_URL = base;
}
async function mcp(secret: string, tool: string, args: Record<string, unknown>) {
  const client = new Client({ name: 'onboarding-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
    return await client.callTool({ name: tool, arguments: args });
  } finally { await client.close(); }
}
const policy = { maxPerTxn: 1000, dailyBudget: 10000, approvalThreshold: 1000, budgetMode: 'hard-stop',
  allowedVendors: '*', blockedVendors: ['blocked'], newVendorRequiresApproval: false, allowedDays: '*', allowedWindow: null };
let id: string, credential: { id: string; secret: string };
function worker(input: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/onboarding-worker.ts'], { env: process.env, stdio: ['pipe','pipe','pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
    child.stdin.end(JSON.stringify(input));
  });
}
beforeAll(async () => {
  operatorId = (await provisionOperator('operator', 'onboarding password 123')).operatorId;
  await startServer();
  const login = await request('/api/auth/login', 'POST', { username: 'operator', password: 'onboarding password 123' }, false);
  cookie = login.headers.get('set-cookie')!.split(';')[0]; csrf = (await login.json()).csrfToken;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
it('starts from an empty account and protects progress with operator session and CSRF', async () => {
  expect(store.listAgents()).toEqual([]);
  expect((await request('/api/onboarding', 'GET', undefined, false)).status).toBe(401);
  expect((await fetch(base + '/api/onboarding', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
});
it('concurrent starts return one active journey, saves validated drafts and rejects stale edits', async () => {
  const responses = await Promise.all([request('/api/onboarding', 'POST', { requestId: randomUUID() }), request('/api/onboarding', 'POST', { requestId: randomUUID() })]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  const drafts = await Promise.all(responses.map(r => r.json())); id = drafts[0].id;
  expect(drafts[1].id).toBe(id);
  const draft = { agentId: 'new-agent', displayName: 'New agent', currency: 'GBP', policy };
  expect((await request(`/api/onboarding/${id}`, 'PATCH', { expectedRevision: 1, draft })).status).toBe(200);
  expect((await request(`/api/onboarding/${id}`, 'PATCH', { expectedRevision: 1, draft })).status).toBe(409);
  expect((await request(`/api/onboarding/${randomUUID()}`)).status).toBe(404);
  expect(() => ownedJourney(id, 'another-operator')).toThrow('Unknown onboarding journey');
});
it('uses shared agent creation once, with authenticated initial policy history and retry conflict detection', async () => {
  const body = { agentId: 'new-agent', displayName: 'New agent', currency: 'GBP', policy, onboardingId: id, expectedRevision: 2 };
  const responses = await Promise.all([request('/api/agents', 'POST', body), request('/api/agents', 'POST', body)]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 201]);
  expect(store.listAgents()).toHaveLength(1);
  expect(store.policyHistory('new-agent')).toHaveLength(1);
  expect(store.policyHistory('new-agent')[0]).toMatchObject({ changedBy: operatorId, after: { ...policy, agentId: 'new-agent' } });
  expect((await request('/api/agents', 'POST', { ...body, currency: 'USD' })).status).toBe(409);
});
it('credential retries return metadata only; explicit rotation recovers a lost secret without duplicate replacements', async () => {
  const path = '/api/agents/new-agent/credentials';
  const responses = await Promise.all([request(path, 'POST', { onboardingId: id }), request(path, 'POST', { onboardingId: id })]);
  const bodies = await Promise.all(responses.map(r => r.json()));
  credential = bodies.find(b => b.secret);
  expect(credential.secret).toBeTruthy(); expect(bodies.filter(b => b.secret)).toHaveLength(1);
  expect(bodies[0].id).toBe(bodies[1].id);
  const old = credential;
  const rotated = await Promise.all([request(`${path}/${old.id}/rotate`, 'POST', { onboardingId: id }), request(`${path}/${old.id}/rotate`, 'POST', { onboardingId: id })]);
  const results = await Promise.all(rotated.map(r => r.json())); credential = results.find(b => b.secret);
  expect(results[0].id).toBe(results[1].id); expect(results.filter(b => b.secret)).toHaveLength(1);
  expect(authenticateAgent(old.secret)).toBeNull(); expect(authenticateAgent(credential.secret)?.agentId).toBe('new-agent');
  const resume = await (await request(`/api/onboarding/${id}`)).json();
  expect(resume.credentialId).toBe(credential.id); expect(JSON.stringify(resume)).not.toContain(credential.secret);
});
it('actual scoped MCP handshake verifies a single-use challenge; foreign, expired and revoked credentials cannot verify it', async () => {
  const challenge = await (await request(`/api/onboarding/${id}/challenge`, 'POST', {})).json();
  expect((await request('/api/agents', 'POST', { agentId: 'foreign-agent', currency: 'GBP' })).status).toBe(201);
  const foreign = issueCredential('foreign-agent', operatorId);
  expect((await mcp(foreign.secret, 'connection_check', { challenge: challenge.challenge })).isError).toBe(true);
  expect((await request(`/api/onboarding/${id}`)).status).toBe(200);
  expect((await (await request(`/api/onboarding/${id}`)).json()).connectedAt).toBeNull();
  expect((await mcp(credential.secret, 'connection_check', { challenge: 'invalid' })).isError).toBe(true);
  const result = await mcp(credential.secret, 'connection_check', { challenge: challenge.challenge });
  expect(result.isError).not.toBe(true); expect(result.structuredContent).toMatchObject({ agentId: 'new-agent', verified: true });
  expect((await mcp(credential.secret, 'connection_check', { challenge: challenge.challenge })).isError).toBe(true);
  const expired = await (await request(`/api/onboarding/${id}/challenge`, 'POST', {})).json();
  db.prepare('UPDATE onboarding_challenges SET expires_at=0').run();
  expect((await mcp(credential.secret, 'connection_check', { challenge: expired.challenge })).isError).toBe(true);
  const fresh = await (await request(`/api/onboarding/${id}/challenge`, 'POST', {})).json();
  expect((await mcp(credential.secret, 'connection_check', { challenge: fresh.challenge })).isError).not.toBe(true);
});
it('rejects a saved policy changed by another writer during simulation rather than labelling stale output current', async () => {
  const initial = store.getPolicy('new-agent')!;
  const realPreview = simulation.preview;
  const spy = vi.spyOn(simulation, 'preview').mockImplementationOnce((agentId, proposed, sample) => {
    // Deterministically interleave a real policy commit at the service boundary.
    store.upsertPolicy({ ...initial, blockedVendors: ['example'] }, { changedBy: operatorId, source: 'operator' });
    return realPreview(agentId, proposed, sample);
  });
  try {
    const response = await request(`/api/onboarding/${id}/test`, 'POST', { sample: { amount: 100, currency: 'GBP', vendor: 'example', purpose: 'Race', rail: 'mcp' } });
    expect(response.status).toBe(409);
    expect((await (await request(`/api/onboarding/${id}`)).json()).testedAt).toBeNull();
  } finally { spy.mockRestore(); store.upsertPolicy(initial, { changedBy: operatorId, source: 'operator' }); }
});
it('saved-policy and labelled fixture tests are pure across retries, and progress survives restart', async () => {
  const tables = ['ledger','approvals','spend_requests','budget_reservations','budget_accounting_events','notification_outbox','idempotency_keys','policy_evidence','policy_revisions'];
  const snapshot = () => tables.map(t => db.prepare(`SELECT * FROM ${t}`).all());
  const before = snapshot();
  const sample = { amount: 100, currency: 'GBP', vendor: 'example', purpose: 'Onboarding test', rail: 'mcp' };
  const result = await mcp(credential.secret, 'onboarding_test', { onboardingId: id, sample });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ mode: 'simulation', saved: { verdict: { decision: 'ALLOW' } } });
  expect((result.structuredContent as any).examples.map((e: any) => e.preview.verdict.decision)).toEqual(['ALLOW','ESCALATE','DENY']);
  const again = await request(`/api/onboarding/${id}/test`, 'POST', { sample }); expect(again.status).toBe(200);
  expect(snapshot()).toEqual(before);
  await new Promise<void>(resolve => server.close(() => resolve())); await startServer();
  const resume = await (await request(`/api/onboarding/${id}`)).json();
  expect(resume).toMatchObject({ agentId: 'new-agent', credentialId: credential.id });
  expect(resume.testedAt).toBeTruthy(); expect(resume.connectedAt).toBeTruthy();
  expect(await worker({ action: 'read', id, operatorId })).toMatchObject({ agentId: 'new-agent', credentialId: credential.id, testedAt: resume.testedAt });
  expect((await request(`/api/onboarding/${id}/complete`, 'POST', {})).status).toBe(200);
});
it('independent writers serialize setup and credential issuance without duplicates', async () => {
  const journey = await (await request('/api/onboarding', 'POST', { requestId: randomUUID() })).json();
  const draft = { agentId: 'process-agent', displayName: 'Independent writers', currency: 'GBP', policy };
  const saved = await (await request(`/api/onboarding/${journey.id}`, 'PATCH', { expectedRevision: journey.revision, draft })).json();
  const setup = { ...draft, onboardingId: saved.id, expectedRevision: saved.revision };
  const registrations = await Promise.all([worker({ action: 'register', setup, operatorId }), worker({ action: 'register', setup, operatorId })]);
  expect(registrations.map(r => r.created).sort()).toEqual([false, true]);
  const credentials = await Promise.all([worker({ action: 'credential', agentId: draft.agentId, id: saved.id, operatorId }), worker({ action: 'credential', agentId: draft.agentId, id: saved.id, operatorId })]);
  expect(credentials[0].id).toBe(credentials[1].id); expect(credentials.filter(c => c.delivered)).toHaveLength(1);
  expect(store.policyHistory(draft.agentId)).toHaveLength(1);
  expect((await request(`/api/onboarding/${saved.id}/abandon`, 'POST', {})).status).toBe(200);
});
it('revoked credentials invalidate readiness and cannot simulate; progress cannot expose another operator data', async () => {
  revokeCredential('new-agent', credential.id, operatorId);
  await expect(mcp(credential.secret, 'onboarding_test', { onboardingId: id, sample: { amount: 1, currency: 'GBP', vendor: 'test', purpose: 'test', rail: 'mcp' } })).rejects.toThrow();
  expect((await (await request(`/api/onboarding/${id}`)).json()).credentialActive).toBe(false);
  expect((await request(`/api/onboarding/${id}/complete`, 'POST', {})).status).toBe(409);
  // The service uses authenticated identity, never caller-supplied operatorId.
  const forged = await request('/api/onboarding', 'POST', { requestId: randomUUID(), operatorId: 'foreign' });
  expect(forged.status).toBe(200);
  expect(db.prepare('SELECT DISTINCT operator_id FROM onboarding_sessions').all()).toEqual([{ operator_id: operatorId }]);
});
it('rejects a stale setup draft and never rebinds a deleted/recreated agent; an abandoned journey can be restarted', async () => {
  const journey = (await (await request('/api/onboarding')).json()).find((j: any) => !j.completedAt);
  const oldDraft = { agentId: 'generation-agent', displayName: 'Generation', currency: 'GBP', policy };
  const a = await (await request(`/api/onboarding/${journey.id}`, 'PATCH', { expectedRevision: journey.revision, draft: oldDraft })).json();
  const b = await (await request(`/api/onboarding/${journey.id}`, 'PATCH', { expectedRevision: a.revision, draft: { ...oldDraft, currency: 'USD' } })).json();
  expect((await request('/api/agents', 'POST', { ...oldDraft, onboardingId: journey.id, expectedRevision: a.revision })).status).toBe(409);
  expect(store.getPolicy('generation-agent')).toBeNull();
  expect((await request('/api/agents', 'POST', { ...b.draft, onboardingId: journey.id, expectedRevision: b.revision })).status).toBe(201);
  const old = await (await request('/api/agents/generation-agent/credentials', 'POST', { onboardingId: journey.id })).json();
  deleteAgentWithCredentials('generation-agent', operatorId);
  expect((await request('/api/agents', 'POST', { agentId: 'generation-agent', currency: 'JPY' })).status).toBe(201);
  expect((await (await request(`/api/onboarding/${journey.id}`)).json()).agentExists).toBe(false);
  expect((await request(`/api/agents/generation-agent/credentials/${old.id}/rotate`, 'POST', { onboardingId: journey.id })).status).toBe(409);
  expect((await request(`/api/onboarding/${journey.id}/abandon`, 'POST', {})).status).toBe(200);
  const next = await (await request('/api/onboarding', 'POST', { requestId: randomUUID() })).json();
  expect(next.id).not.toBe(journey.id);
});
