import { beforeAll, describe, expect, it, vi } from 'vitest';
await vi.hoisted(async () => { process.env.SPENDGATE_DATA = `/tmp/spendgate-auth-${Date.now()}-${Math.random()}`; (await import('node:fs')).mkdirSync(process.env.SPENDGATE_DATA, { recursive: true }); });
import * as auth from '../src/auth.js';
import { db, store } from '../src/core/store.js';
import { appendLedger, verifyLedger } from '../src/core/ledger.js';
const password = 'correct horse battery staple';
let operator: any;
beforeAll(async () => {
  operator = await auth.provisionOperator('operator', password);
  store.upsertAgent('alpha', 'Alpha', 'GBP');
  store.upsertAgent('beta', 'Beta', 'GBP');
});
describe('operator sessions', () => {
  it('stores salted password hashes and rejects incorrect passwords', async () => {
    const row = db.prepare('SELECT password_hash FROM operators').get()!;
    expect(String(row.password_hash)).not.toContain(password);
    await expect(auth.login('operator', 'wrong', 'one')).rejects.toMatchObject({ status: 401 });
    await expect(auth.login('missing', password, 'two')).rejects.toMatchObject({ status: 401 });
  });
  it('issues hashed sessions, expires idle and absolute sessions and invalidates logout', async () => {
    const session = await auth.login('operator', password, 'three');
    expect(auth.authenticateSession(session.token)).toMatchObject({ kind: 'operator', operatorId: operator.operatorId });
    expect(JSON.stringify(db.prepare('SELECT * FROM operator_sessions').all())).not.toContain(session.token);
    auth.logout(session.token);
    expect(auth.authenticateSession(session.token)).toBeNull();
    const idle = await auth.login('operator', password, 'three');
    db.prepare('UPDATE operator_sessions SET last_seen_at = 0 WHERE id = ?').run(idle.principal.sessionId);
    expect(auth.authenticateSession(idle.token)).toBeNull();
    const absolute = await auth.login('operator', password, 'three');
    db.prepare('UPDATE operator_sessions SET expires_at = 0 WHERE id = ?').run(absolute.principal.sessionId);
    expect(auth.authenticateSession(absolute.token)).toBeNull();
  });
  it('throttles failed login attempts', async () => {
    for (let i = 0; i < 5; i++) await expect(auth.login('operator', 'bad', 'throttled')).rejects.toMatchObject({ status: 401 });
    await expect(auth.login('operator', password, 'throttled')).rejects.toMatchObject({ status: 429 });
  });
  it('refuses reprovisioning and short passwords', async () => {
    await expect(auth.provisionOperator('other', password)).rejects.toThrow();
    await expect(auth.provisionOperator('other', 'short')).rejects.toThrow();
  });
});
describe('agent credentials and audit', () => {
  it('binds identities, rotates atomically and never persists raw secrets', () => {
    const first = auth.issueCredential('alpha', operator.operatorId);
    expect(auth.authenticateAgent(first.secret)).toEqual({ kind: 'agent', agentId: 'alpha', credentialId: first.id });
    const rotated = auth.rotateCredential('alpha', first.id, operator.operatorId);
    expect(auth.authenticateAgent(first.secret)).toBeNull();
    expect(auth.authenticateAgent(rotated.secret)?.agentId).toBe('alpha');
    const stored = JSON.stringify(db.prepare('SELECT * FROM agent_credentials').all());
    expect(stored).not.toContain(first.secret);
    expect(stored).not.toContain(rotated.secret);
    expect(JSON.stringify(auth.listCredentials('alpha'))).not.toContain('token_hash');
    const audit = JSON.stringify(db.prepare('SELECT * FROM security_audit_events').all());
    expect(audit).toContain('credential.created');
    expect(audit).toContain('credential.rotated');
    expect(audit).not.toContain(first.secret);
    auth.revokeCredential('alpha', rotated.id, operator.operatorId);
    expect(auth.authenticateAgent(rotated.secret)).toBeNull();
  });
  it('rejects cross-agent lifecycle operations', () => {
    const credential = auth.issueCredential('alpha', operator.operatorId);
    expect(() => auth.rotateCredential('beta', credential.id, operator.operatorId)).toThrow();
    expect(() => auth.revokeCredential('beta', credential.id, operator.operatorId)).toThrow();
    expect(auth.authenticateAgent(credential.secret)?.agentId).toBe('alpha');
  });
  it('keeps deleted-agent credentials dead after ID reuse', () => {
    store.upsertAgent('deleted', 'Deleted', 'GBP');
    const credential = auth.issueCredential('deleted', operator.operatorId);
    auth.revokeAgentCredentials('deleted', operator.operatorId);
    store.deleteAgent('deleted');
    store.upsertAgent('deleted', 'Replacement', 'GBP');
    expect(auth.authenticateAgent(credential.secret)).toBeNull();
  });
  it('preserves existing monetary ledger rows and migration idempotency', async () => {
    appendLedger({ intent: { id: 'legacy', agentId: 'alpha', amount: 100, currency: 'GBP', vendor: 'vendor', purpose: 'test', rail: 'mcp' }, decision: 'ALLOWED', rule: 'test', decidedBy: 'policy' });
    const before = JSON.stringify(store.fullLedger());
    const { migrate } = await import('../src/core/migrations.js');
    migrate(db);
    expect(JSON.stringify(store.fullLedger())).toBe(before);
    expect(verifyLedger().valid).toBe(true);
  });
});
