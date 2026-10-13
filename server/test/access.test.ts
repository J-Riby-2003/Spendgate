import { afterAll, beforeAll, expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env.SPENDGATE_DATA = `/tmp/spendgate-access-${Date.now()}-${Math.random()}`; });
import { createApplication } from '../src/app.js';
import { provisionOperator, issueCredential, revokeCredential, login, logout } from '../src/auth.js';
import { db, store } from '../src/core/store.js';
import { appendLedger, verifyLedger } from '../src/core/ledger.js';
import { decide } from '../src/core/engine.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';
import { once } from 'node:events';
let server: ReturnType<typeof createApplication>, base: string, cookie: string, csrf: string, operatorId: string, alpha: ReturnType<typeof issueCredential>;
const password = 'test operator password 123';
const clients: Client[] = [];
async function request(path: string, method = 'GET', body?: unknown, headers: Record<string,string> = {}) {
  return fetch(`${base}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
}
function operatorHeaders() { return { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf }; }
async function client(secret: string) {
  const c = new Client({ name: 'access-test', version: '1' }); clients.push(c);
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
  return c;
}
async function until(fn: () => boolean) { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Condition timed out'); }
beforeAll(async () => {
  operatorId = (await provisionOperator('operator', password)).operatorId;
  server = createApplication(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.SPENDGATE_PUBLIC_BASE_URL = base;
  for (const agentId of ['alpha', 'beta']) {
    store.upsertAgent(agentId, agentId, 'GBP');
    store.upsertPolicy({ agentId, maxPerTxn: 1000, dailyBudget: 10000, approvalThreshold: 2000, allowedVendors: '*', blockedVendors: [], newVendorRequiresApproval: false, allowedDays: '*', allowedWindow: null });
    appendLedger({ intent: { id: agentId, agentId, amount: 10, currency: 'GBP', vendor: `${agentId}-secret-vendor`, purpose: 'private', rail: 'mcp' }, decision: 'ALLOWED', rule: 'test', decidedBy: 'policy' });
  }
  alpha = issueCredential('alpha', operatorId);
  const res = await request('/api/auth/login', 'POST', { username: 'operator', password }, { Origin: base });
  expect(res.status).toBe(200);
  cookie = res.headers.get('set-cookie')!.split(';')[0];
  expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/);
  expect(res.headers.get('set-cookie')).toMatch(/SameSite=Strict/i);
  csrf = (await res.json()).csrfToken;
});
afterAll(async () => { for (const c of clients) await c.close(); await new Promise<void>(r => server.close(() => r())); });

it('protects all console reads and administration from anonymous callers and agents', async () => {
  for (const path of ['/api/state','/api/ledger','/api/ledger?agent=beta','/api/ledger/verify','/api/export.csv','/api/export.json','/api/approvals','/api/policies','/api/approvals/missing/links','/api/agents/alpha/credentials','/api/security-audit']) {
    expect((await request(path)).status, path).toBe(401);
    expect((await request(path, 'GET', undefined, { Authorization: `Bearer ${alpha.secret}` })).status, path).toBe(401);
    expect((await request(path, 'GET', undefined, operatorHeaders())).status, path).not.toBe(401);
  }
  expect((await request('/api/agents', 'POST', { agentId: 'intruder' }, { Authorization: `Bearer ${alpha.secret}`, Origin: base })).status).toBe(401);
  expect((await request('/mcp', 'POST', {}, operatorHeaders())).status).toBe(401);
});
it('rejects login origin attacks and requires CSRF for authenticated mutations', async () => {
  expect((await request('/api/auth/login', 'POST', { username: 'operator', password }, { Origin: 'https://evil.example' })).status).toBe(403);
  expect((await request('/api/agents/alpha/credentials', 'POST', {}, { Cookie: cookie, Origin: base })).status).toBe(403);
  expect((await request('/api/agents/alpha/credentials', 'POST', {}, { ...operatorHeaders(), Origin: 'https://evil.example' })).status).toBe(403);
  const issued = await request('/api/agents/alpha/credentials', 'POST', {}, operatorHeaders());
  expect(issued.status).toBe(201);
  const credential = await issued.json();
  const list = await request('/api/agents/alpha/credentials', 'GET', undefined, operatorHeaders());
  expect(JSON.stringify(await list.json())).not.toContain(credential.secret);
  const rotated = await request(`/api/agents/alpha/credentials/${credential.id}/rotate`, 'POST', {}, operatorHeaders());
  expect(rotated.status).toBe(201);
  const next = await rotated.json();
  expect((await request(`/api/agents/alpha/credentials/${next.id}`, 'DELETE', undefined, operatorHeaders())).status).toBe(200);
});
it('rejects identity mismatches across every MCP tool and scopes omitted audit filters', async () => {
  const c = await client(alpha.secret);
  for (const name of ['spend', 'budget_status', 'audit_ledger']) {
    const result = await c.callTool({ name, arguments: { agent: 'beta', ...(name === 'spend' ? { amount: 10, currency: 'GBP', vendor: 'vendor', purpose: 'impersonation' } : {}) } });
    expect(result.isError, name).toBe(true);
    expect(JSON.stringify(result)).not.toContain('beta-secret-vendor');
  }
  const ledger = await c.callTool({ name: 'audit_ledger', arguments: {} });
  expect(ledger.isError).not.toBe(true);
  expect(JSON.stringify(ledger)).toContain('alpha-secret-vendor');
  expect(JSON.stringify(ledger)).not.toContain('beta-secret-vendor');
  const spend = await c.callTool({ name: 'spend', arguments: { amount: 10, currency: 'GBP', vendor: 'vendor', purpose: 'own spend' } });
  expect(spend.isError).toBe(false);
});
it('takes the approval actor from the session, ignoring caller-supplied attribution', async () => {
  const c = await client(alpha.secret);
  const promise = c.callTool({ name: 'spend', arguments: { amount: 3000, currency: 'GBP', vendor: 'vendor', purpose: 'actor-test' } });
  await until(() => store.pendingApprovals().some(a => a.intent.purpose === 'actor-test'));
  const a = store.pendingApprovals().find(a => a.intent.purpose === 'actor-test')!;
  expect((await request(`/api/approvals/${a.id}/decide`, 'POST', { approve: true, by: 'forged' }, operatorHeaders())).status).toBe(200);
  await promise;
  expect(store.getApproval(a.id)?.decidedBy).toBe(operatorId);
  expect(store.recentLedger(1)[0].decidedBy).toBe(`human:${operatorId}`);
});
it('rejects unauthenticated and foreign-origin WebSocket upgrades', async () => {
  for (const headers of [{ Origin: base }, { Cookie: cookie, Origin: 'https://evil.example' }, { Authorization: `Bearer ${alpha.secret}`, Origin: base }]) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers });
    const [, response] = await once(ws, 'unexpected-response');
    expect((response as any).statusCode).toBeGreaterThanOrEqual(400);
    ws.terminate(); ws.on('error', () => {});
  }
});
it('closes live WebSockets on logout and expiry and rejects expired REST sessions', async () => {
  for (const mode of ['logout', 'idle', 'absolute']) {
    const session = await login('operator', password, `ws-${mode}`);
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: `sg-session=${session.token}`, Origin: base } });
    await once(ws, 'message');
    const closed = once(ws, 'close');
    if (mode === 'logout') logout(session.token);
    else db.prepare(`UPDATE operator_sessions SET ${mode === 'idle' ? 'last_seen_at' : 'expires_at'}=0 WHERE id=?`).run(session.principal.sessionId);
    await closed;
    expect((await request('/api/state', 'GET', undefined, { Cookie: `sg-session=${session.token}` })).status).toBe(401);
  }
});
it('revocation closes an active MCP stream without cancelling its pending request', async () => {
  const cred = issueCredential('alpha', operatorId); const c = await client(cred.secret);
  const result = c.callTool({ name: 'spend', arguments: { amount: 3000, currency: 'GBP', vendor: 'vendor', purpose: 'revocation-test' } }).then(() => 'resolved', () => 'closed');
  await until(() => store.pendingApprovals().some(a => a.intent.purpose === 'revocation-test'));
  const a = store.pendingApprovals().find(a => a.intent.purpose === 'revocation-test')!;
  revokeCredential('alpha', cred.id, operatorId);
  expect(await result).toBe('closed');
  expect(store.getApproval(a.id)?.status).toBe('pending');
  expect((await request('/mcp', 'POST', {}, { Authorization: `Bearer ${cred.secret}` })).status).toBe(401);
  decide(a.id, false, operatorId);
  await until(() => store.fullLedger().some(e => e.approvalId === a.id));
  expect(verifyLedger().valid).toBe(true);
});

it('background reads do not renew idle time; authenticated user activity does', async () => {
  const session = await login('operator', password, 'activity');
  const before = Date.now() - 1000;
  db.prepare('UPDATE operator_sessions SET last_seen_at=? WHERE id=?').run(before, session.principal.sessionId);
  const headers = { Cookie: `sg-session=${session.token}`, Origin: base, 'X-CSRF-Token': session.csrfToken };
  expect((await request('/api/state', 'GET', undefined, headers)).status).toBe(200);
  expect(Number(db.prepare('SELECT last_seen_at FROM operator_sessions WHERE id=?').get(session.principal.sessionId)!.last_seen_at)).toBe(before);
  expect((await request('/api/auth/activity', 'POST', {}, headers)).status).toBe(200);
  expect(Number(db.prepare('SELECT last_seen_at FROM operator_sessions WHERE id=?').get(session.principal.sessionId)!.last_seen_at)).toBeGreaterThan(before);
});
