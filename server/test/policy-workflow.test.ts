import { beforeEach, expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env.SPENDGATE_DATA = `/tmp/spendgate-policy-workflow-${Date.now()}-${Math.random()}`; });
import { db, store, withImmediateTransaction } from '../src/core/store.js';
import { submitRequest, decide, getRequest } from '../src/core/engine.js';
import { evaluate } from '../src/core/policy.js';
import * as simulation from '../src/core/simulation.js';
import { verifyLedger } from '../src/core/ledger.js';
import type { Policy } from '../src/core/types.js';
const policy: Policy = { agentId: 'preview', maxPerTxn: 100, dailyBudget: 1000, budgetMode: 'hard-stop', approvalThreshold: null, allowedVendors: '*', blockedVendors: [], newVendorRequiresApproval: false, allowedDays: '*', allowedWindow: null };
const input = { agentId: 'preview', amount: 50, currency: 'GBP', vendor: 'Acme', purpose: 'sample', rail: 'mcp' as const };
beforeEach(() => {
  db.exec('DELETE FROM policy_evidence; DELETE FROM spend_requests; DELETE FROM approvals; DELETE FROM notification_outbox; DELETE FROM idempotency_keys; DELETE FROM ledger; DELETE FROM budget_reservations; DELETE FROM budget_accounting_events;');
  store.upsertAgent('preview', 'Preview', 'GBP'); store.upsertPolicy(policy);
});
const databaseState = () => JSON.stringify(['policies','policy_revisions','policy_evidence','spend_requests','ledger','approvals','budget_reservations','idempotency_keys','notification_outbox','budget_accounting_events'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
it('versions policy updates atomically, rejects stale writes and rolls back failed history writes', () => {
  const version = store.getPolicyVersion('preview');
  store.upsertPolicy({ ...policy, maxPerTxn: 20 }, { expectedVersion: version, changedBy: 'operator-id', source: 'operator' });
  expect(store.getPolicyVersion('preview')).toBe(version + 1);
  expect(store.policyHistory('preview', 1)[0]).toMatchObject({ version: version + 1, changedBy: 'operator-id', before: policy, after: { ...policy, maxPerTxn: 20 } });
  expect(() => store.upsertPolicy(policy, { expectedVersion: version, changedBy: 'other', source: 'operator' })).toThrow(/changed/);
  const before = databaseState();
  db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON policy_revisions BEGIN SELECT RAISE(ABORT, 'history failure'); END");
  try { expect(() => store.upsertPolicy(policy)).toThrow(/history failure/); }
  finally { db.exec('DROP TRIGGER fail_history'); }
  expect(databaseState()).toBe(before);
});
it('previews the same production result without any persisted side effects and rejects currency mismatch', () => {
  const before = databaseState();
  const preview = simulation.preview('preview', policy, input);
  expect(preview.verdict).toEqual({ decision: 'ALLOW', rule: 'within-policy', reason: 'Within all policy limits.' });
  expect(preview.context.budget).toMatchObject({ reservedMinor: 0, timezone: 'UTC' });
  expect(databaseState()).toBe(before);
  expect(() => simulation.preview('preview', policy, { ...input, currency: 'USD' })).toThrow(/currency/);
  const real = submitRequest(input);
  const evidence = simulation.requestEvidence(real.requestId)!;
  expect(evidence.envelope.verdict).toEqual(preview.verdict);
  expect(evidence.integrity).toBe('verified');
  expect(store.ledgerEntryBySeq(real.ledgerSeq!)?.details?.evidence?.digest).toBe(evidence.digest);
  expect(evidence.envelope.context.budget.reservedMinor).toBe(0);
  expect(simulation.preview('preview', policy, input).context.budget.reservedMinor).toBe(50);
});
it('retains original evidence through policy changes, retries and approval-time rechecks', () => {
  const pending = submitRequest({ ...input, amount: 120, idempotencyKey: 'same' });
  const evidence = simulation.requestEvidence(pending.requestId);
  store.upsertPolicy({ ...policy, maxPerTxn: 200 });
  expect(submitRequest({ ...input, amount: 120, idempotencyKey: 'same' }).requestId).toBe(pending.requestId);
  expect(decide(pending.approvalId!, true, 'operator', 'reviewed')).toBe(true);
  expect(simulation.requestEvidence(pending.requestId)).toEqual(evidence);
  const final = getRequest('preview', pending.requestId);
  expect(store.ledgerEntryBySeq(final.ledgerSeq!)?.details?.evidence?.digest).toBe(evidence!.digest);
  expect(verifyLedger().valid).toBe(true);
});
it('replays unique pending/final requests with fixed original context and reports legacy missing coverage', () => {
  const allowed = submitRequest(input);
  const pending = submitRequest({ ...input, amount: 120 });
  db.prepare('INSERT INTO spend_requests (request_id,agent_id,intent_json,reason) VALUES (?,?,?,?)').run('old', 'preview', JSON.stringify({ ...input, id: 'old' }), 'legacy');
  const before = databaseState();
  const result = simulation.replay('preview', { ...policy, maxPerTxn: 20 }, store.getPolicyVersion('preview'), 50);
  expect(result.coverage).toEqual({ selected: 3, evaluated: 2, unavailable: 1 });
  expect(result.changedOutcomes).toBe(1);
  expect(result.rows.find(r => r.requestId === allowed.requestId)).toMatchObject({ current: { decision: 'ALLOW' }, proposed: { decision: 'ESCALATE' } });
  expect(result.rows.find(r => r.requestId === pending.requestId)?.current.decision).toBe('ESCALATE');
  expect(databaseState()).toBe(before);
  for (const limit of [0, -1, 501, 1.5, NaN]) expect(() => simulation.replay('preview', policy, store.getPolicyVersion('preview'), limit)).toThrow(/limit/i);
});
it('rolls back evidence with failed ledger append and does not accept forged trusted references', () => {
  const before = databaseState();
  db.exec("CREATE TRIGGER fail_decision BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT, 'ledger failure'); END");
  try { expect(() => submitRequest(input)).toThrow(/ledger failure/); }
  finally { db.exec('DROP TRIGGER fail_decision'); }
  expect(databaseState()).toBe(before);
  expect(() => submitRequest(input, { evidence: { schemaVersion: 1, digest: 'a'.repeat(64) } })).toThrow(/evidence/i);
});
it('reports corrupted evidence as unavailable and never silently replays it', () => {
  const real = submitRequest(input);
  db.prepare('UPDATE policy_evidence SET envelope_json=? WHERE request_id=?').run('{}', real.requestId);
  expect(simulation.requestEvidence(real.requestId)?.integrity).toBe('invalid');
  expect(simulation.replay('preview', policy, store.getPolicyVersion('preview')).coverage).toEqual({ selected: 1, evaluated: 0, unavailable: 1 });
});
it('handles inclusive overnight and equal-minute UTC windows consistently', () => {
  const p = { ...policy, allowedWindow: { start: '22:00', end: '06:00' } };
  const at = (time: string, override = p) => evaluate(override, { ...input, id: 'sample' }, { spentTodayMinor: 0, knownVendors: new Set(), now: new Date(`2026-10-13T${time}Z`) }).decision;
  for (const time of ['22:00:00', '23:59:59', '00:00:00', '06:00:59']) expect(at(time)).toBe('ALLOW');
  for (const time of ['21:59:59', '06:01:00', '12:00:00']) expect(at(time)).toBe('ESCALATE');
  expect(at('08:00:59', { ...p, allowedWindow: { start: '08:00', end: '08:00' } })).toBe('ALLOW');
  expect(at('08:01:00', { ...p, allowedWindow: { start: '08:00', end: '08:00' } })).toBe('ESCALATE');
  expect(at('00:00:00', { ...p, allowedDays: [1] })).toBe('ESCALATE'); // Tuesday, not Monday's window
});
it('uses deterministic bounded evidence encoding and validates malformed/unbounded envelopes', async () => {
  const { encodeEvidence, MAX_EVIDENCE_BYTES } = await import('../src/core/policy-evidence.js');
  const real = submitRequest(input), original = simulation.requestEvidence(real.requestId)!.envelope!;
  const encoded = encodeEvidence(original);
  expect(encodeEvidence(Object.fromEntries(Object.entries(original).reverse())).digest).toBe(encoded.digest);
  expect(Buffer.byteLength(encoded.json, 'utf8')).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);
  expect(() => encodeEvidence({ ...original, verdict: { ...original.verdict, reason: 'x'.repeat(20000) } })).toThrow();
  expect(() => encodeEvidence({ ...original, context: { ...original.context, budget: { ...original.context.budget, remainingMinor: 123 } } })).toThrow();
});
it('matches simulation and production across budget, threshold, vendor and UTC boundaries', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-10-13T23:00:00Z'));
    const cases: { policy: Policy; amount: number; decision: string; rule: string }[] = [
      { policy: { ...policy, maxPerTxn: null, dailyBudget: 100 }, amount: 100, decision: 'ALLOW', rule: 'within-policy' },
      { policy: { ...policy, maxPerTxn: null, dailyBudget: 100 }, amount: 101, decision: 'DENY', rule: 'over-daily-budget' },
      { policy: { ...policy, maxPerTxn: null, dailyBudget: 100, budgetMode: 'approval-override' }, amount: 101, decision: 'ESCALATE', rule: 'over-daily-budget' },
      { policy: { ...policy, approvalThreshold: 50 }, amount: 50, decision: 'ESCALATE', rule: 'over-approval-threshold' },
      { policy: { ...policy, newVendorRequiresApproval: true }, amount: 50, decision: 'ESCALATE', rule: 'new-vendor' },
      { policy: { ...policy, allowedWindow: { start: '22:00', end: '06:00' } }, amount: 50, decision: 'ALLOW', rule: 'within-policy' },
      { policy: { ...policy, allowedDays: [1] }, amount: 50, decision: 'ESCALATE', rule: 'outside-allowed-days' },
    ];
    for (const [i, c] of cases.entries()) {
      const agentId = `parity-${i}`, p = { ...c.policy, agentId }, request = { ...input, agentId, amount: c.amount };
      store.upsertAgent(agentId, agentId, 'GBP'); store.upsertPolicy(p);
      const preview = simulation.preview(agentId, p, request);
      expect(preview.verdict).toMatchObject({ decision: c.decision, rule: c.rule });
      const real = submitRequest(request);
      expect(simulation.requestEvidence(real.requestId)!.envelope!.verdict).toEqual(preview.verdict);
    }
  } finally { vi.useRealTimers(); }
});
it('normalises historical vendor case and reflects reservations in both preview and production evidence', () => {
  submitRequest(input);
  store.upsertPolicy({ ...policy, newVendorRequiresApproval: true, dailyBudget: 100 });
  const preview = simulation.preview('preview', store.getPolicy('preview'), { ...input, vendor: 'ACME', amount: 51 });
  expect(preview.context.vendorKnown).toBe(true);
  expect(preview.verdict.rule).toBe('over-daily-budget');
  const real = submitRequest({ ...input, vendor: 'ACME', amount: 51 });
  expect(simulation.requestEvidence(real.requestId)!.envelope!.verdict).toEqual(preview.verdict);
});
it('never labels altered signed requests or forged signed references as verified evidence', () => {
  const real = submitRequest(input);
  const row = db.prepare('SELECT intent_json FROM spend_requests WHERE request_id=?').get(real.requestId)!;
  db.prepare('UPDATE spend_requests SET intent_json=? WHERE request_id=?').run(JSON.stringify({ ...JSON.parse(String(row.intent_json)), amount: 900 }), real.requestId);
  expect(simulation.requestEvidence(real.requestId)?.integrity).toBe('invalid');
  db.prepare('UPDATE spend_requests SET intent_json=? WHERE request_id=?').run(row.intent_json, real.requestId);
  const ledger = store.ledgerEntryBySeq(real.ledgerSeq!)!;
  db.prepare('UPDATE ledger SET signature=? WHERE seq=?').run('f'.repeat(64), real.ledgerSeq!);
  expect(simulation.requestEvidence(real.requestId)?.integrity).toBe('invalid');
  db.prepare('UPDATE ledger SET signature=? WHERE seq=?').run(ledger.signature, real.ledgerSeq!);
});
it('excludes historical requests in a different configured currency instead of reinterpreting policy amounts', () => {
  const real = submitRequest(input);
  withImmediateTransaction(() => { const r = db.prepare('SELECT request_id FROM budget_reservations WHERE request_id=?').get(real.requestId)!; db.prepare("UPDATE budget_reservations SET status='released' WHERE request_id=?").run(r.request_id); store.upsertAgent('preview', 'Preview', 'USD'); });
  const result = simulation.replay('preview', policy, store.getPolicyVersion('preview'));
  expect(result.coverage.unavailable).toBe(1);
  expect(result.unavailable[0].reason).toMatch(/currency/i);
});
it('binds pending requests to their original evidence and makes revision history append-only', () => {
  const pending = submitRequest({ ...input, amount: 120 });
  db.prepare('UPDATE spend_requests SET intent_json=? WHERE request_id=?').run(JSON.stringify({ ...input, id: pending.requestId, amount: 121 }), pending.requestId);
  expect(simulation.requestEvidence(pending.requestId)?.integrity).toBe('invalid');
  expect(() => db.prepare('UPDATE policy_revisions SET changed_by=? WHERE agent_id=?').run('forged', 'preview')).toThrow(/immutable/);
  expect(() => db.prepare('DELETE FROM policy_revisions WHERE agent_id=?').run('preview')).toThrow(/immutable/);
});
