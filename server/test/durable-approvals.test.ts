import { beforeAll, expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env.SPENDLOCK_DATA = `/tmp/spendlock-durable-${Date.now()}-${Math.random()}`; });
import * as engine from '../src/core/engine.js';
import { store, db } from '../src/core/store.js';
import { budget } from '../src/core/budget-state.js';
import { verifyLedger } from '../src/core/ledger.js';
import { mintDecisionLinks, decideByToken } from '../src/decide-links.js';
const input = { agentId: 'durable', amount: 60, currency: 'GBP', vendor: 'acme', purpose: 'durable test', rail: 'mcp' as const };
beforeAll(() => {
  store.upsertAgent('durable', 'Durable', 'GBP');
  store.upsertPolicy({ agentId: 'durable', maxPerTxn: 50, dailyBudget: 1000, budgetMode: 'hard-stop', approvalThreshold: null, allowedVendors: '*', blockedVendors: [], newVendorRequiresApproval: false, allowedDays: '*', allowedWindow: null });
});
it('returns durable pending identity and matching retries without reserving funds', () => {
  const first = engine.submitRequest({ ...input, idempotencyKey: 'pending' });
  expect(first.decision).toBe('PENDING');
  expect(first.expiresAt).toBeTruthy();
  expect(engine.submitRequest({ ...input, idempotencyKey: 'pending' })).toEqual(first);
  expect(budget.getReservation(first.requestId)).toBeNull();
  expect(() => engine.submitRequest({ ...input, amount: 61, idempotencyKey: 'pending' })).toThrow(/different/i);
  expect(() => engine.getRequest('foreign', first.requestId)).toThrow(/Unknown/);
});
it('finalises and signs notes without any waiter; retry reads the same final outcome', () => {
  const pending = engine.submitRequest({ ...input, idempotencyKey: 'no-waiter' });
  expect(engine.decide(pending.approvalId!, true, 'operator', 'reviewed')).toBe(true);
  const final = engine.getRequest(input.agentId, pending.requestId);
  expect(final.decision).toBe('APPROVED');
  expect(engine.submitRequest({ ...input, idempotencyKey: 'no-waiter' })).toEqual(final);
  expect(engine.decide(pending.approvalId!, false, 'other')).toBe(false);
  expect(store.fullLedger().filter(e => e.intentId === pending.requestId)).toHaveLength(1);
  const entry = store.ledgerEntryBySeq(final.ledgerSeq!)!;
  expect(entry.eventVersion).toBe(2);
  expect(entry.details?.note).toBe('reviewed');
  expect(verifyLedger().valid).toBe(true);
  db.prepare('UPDATE ledger SET details_json=? WHERE seq=?').run('{"note":"tampered"}', final.ledgerSeq!);
  expect(verifyLedger().valid).toBe(false);
  db.prepare('UPDATE ledger SET details_json=? WHERE seq=?').run(JSON.stringify(entry.details), final.ledgerSeq!);
});
it('enforces persisted exact deadline on console decisions and reads; never releases execution holds', () => {
  const pending = engine.submitRequest({ ...input, idempotencyKey: 'boundary' });
  const deadline = new Date(Date.now() - 1).toISOString();
  db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(deadline, pending.approvalId!);
  expect(engine.decide(pending.approvalId!, true, 'operator')).toBe(false);
  expect(store.getApproval(pending.approvalId!)?.status).toBe('expired');
  expect(engine.getRequest(input.agentId, pending.requestId).decision).toBe('EXPIRED');
  expect(budget.getReservation(pending.requestId)).toBeNull();
  const approved = engine.submitRequest({ ...input, idempotencyKey: 'held' });
  engine.decide(approved.approvalId!, true, 'operator');
  db.prepare('UPDATE budget_reservations SET expires_at=? WHERE request_id=?').run(deadline, approved.requestId);
  engine.expireStale();
  expect(budget.getReservation(approved.requestId)?.status).toBe('reserved');
});
it('consumes phone links in the same transaction and invalidates sibling links', () => {
  const pending = engine.submitRequest({ ...input, idempotencyKey: 'phone' });
  const links = mintDecisionLinks(store.getApproval(pending.approvalId!)!);
  expect(decideByToken(links[0].token).decision).toBe('approved');
  expect(() => decideByToken(links[0].token)).toThrow(/used/);
  expect(() => decideByToken(links[1].token)).toThrow(/decided|used/);
  expect(engine.getRequest(input.agentId, pending.requestId).decision).toBe('APPROVED');
});
it('rolls finalisation back if the ledger write fails, including reservation and link consumption', () => {
  const pending = engine.submitRequest({ ...input, idempotencyKey: 'rollback' });
  const links = mintDecisionLinks(store.getApproval(pending.approvalId!)!);
  db.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT, 'test ledger failure'); END");
  try { expect(() => decideByToken(links[0].token)).toThrow(/ledger failure/); }
  finally { db.exec('DROP TRIGGER fail_ledger'); }
  expect(store.getApproval(pending.approvalId!)?.status).toBe('pending');
  expect(budget.getReservation(pending.requestId)).toBeNull();
  expect(decideByToken(links[0].token).decision).toBe('approved');
});
it('rejects invalid configured expiry bounds and preserves existing deadlines', () => {
  for (const value of ['0', 'NaN', '59999', '604800001', '60000.5']) expect(() => engine.approvalTimeout({ SPENDLOCK_APPROVAL_TIMEOUT_MS: value })).toThrow(/60000/);
  expect(engine.approvalTimeout({ SPENDLOCK_APPROVAL_TIMEOUT_MS: '60000' })).toBe(60000);
  expect(engine.approvalTimeout({ SPENDLOCK_APPROVAL_TIMEOUT_MS: '604800000' })).toBe(604800000);
  const pending = engine.submitRequest({ ...input, idempotencyKey: 'immutable-expiry' });
  process.env.SPENDLOCK_APPROVAL_TIMEOUT_MS = '60000';
  expect(engine.getRequest(input.agentId, pending.requestId).expiresAt).toBe(pending.expiresAt);
  delete process.env.SPENDLOCK_APPROVAL_TIMEOUT_MS;
});
it('persists failed delivery, retries once due, and suppresses already-final jobs', async () => {
  const { deliverNotifications } = await import('../src/notify.js');
  // Isolate this job from earlier pending test requests.
  db.prepare("UPDATE notification_outbox SET status='obsolete'").run();
  const pending = engine.submitRequest({ ...input, idempotencyKey: 'outbox' });
  let calls = 0;
  const notifier = { name: 'test', async send() { calls++; if (calls === 1) throw new Error('secret must not be persisted'); } };
  await deliverNotifications(notifier);
  const failed = db.prepare('SELECT * FROM notification_outbox WHERE approval_id=?').get(pending.approvalId!)!;
  expect(failed.status).toBe('retry'); expect(failed.attempts).toBe(1);
  expect(failed.last_error).not.toContain('secret');
  await deliverNotifications(notifier); expect(calls).toBe(1);
  db.prepare('UPDATE notification_outbox SET next_attempt_at=0 WHERE approval_id=?').run(pending.approvalId!);
  await Promise.all([deliverNotifications(notifier), deliverNotifications(notifier)]);
  expect(calls).toBe(2);
  expect(db.prepare('SELECT status FROM notification_outbox WHERE approval_id=?').get(pending.approvalId!)?.status).toBe('delivered');
  const obsolete = engine.submitRequest({ ...input, idempotencyKey: 'obsolete-outbox' });
  engine.decide(obsolete.approvalId!, false, 'operator');
  await deliverNotifications(notifier); expect(calls).toBe(2);
});
it('blocks approval acquisition while the agent has another unresolved legacy request', () => {
  const ambiguous = engine.submitRequest({ ...input, idempotencyKey: 'unknown-exposure' });
  const pending = engine.submitRequest({ ...input, idempotencyKey: 'gated-existing' });
  db.prepare('UPDATE spend_requests SET reconciliation_required=1 WHERE request_id=?').run(ambiguous.requestId);
  try {
    expect(() => engine.decide(pending.approvalId!, true, 'operator')).toThrow(/reconciliation/);
    expect(store.getApproval(pending.approvalId!)?.status).toBe('pending');
    expect(budget.getReservation(pending.requestId)).toBeNull();
    expect(engine.decide(pending.approvalId!, false, 'operator')).toBe(true);
  } finally { db.prepare('UPDATE spend_requests SET reconciliation_required=0 WHERE request_id=?').run(ambiguous.requestId); }
});
it('expires exactly at the persisted boundary, while a decision one millisecond before it succeeds', () => {
  const before = engine.submitRequest({ ...input, idempotencyKey: 'before-boundary' });
  const exact = engine.submitRequest({ ...input, idempotencyKey: 'exact-boundary' });
  const deadline = new Date(Date.now() + 1000);
  db.prepare('UPDATE approvals SET expires_at=? WHERE id IN (?,?)').run(deadline.toISOString(), before.approvalId!, exact.approvalId!);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(deadline.getTime() - 1);
    expect(engine.decide(before.approvalId!, false, 'operator')).toBe(true);
    vi.setSystemTime(deadline);
    expect(engine.decide(exact.approvalId!, true, 'operator')).toBe(false);
    expect(engine.getRequest(input.agentId, exact.requestId).decision).toBe('EXPIRED');
  } finally { vi.useRealTimers(); }
});
it('classifies Telegram authentication failures as permanent and rate limits as retryable without storing response secrets', async () => {
  const { deliverNotifications, telegramNotifier } = await import('../src/notify.js');
  db.prepare("UPDATE notification_outbox SET status='obsolete'").run();
  const permanent = engine.submitRequest({ ...input, idempotencyKey: 'telegram-permanent' });
  await deliverNotifications(telegramNotifier({ botToken: 'secret', chatId: 'chat', baseUrl: 'https://gate.example', fetchImpl: async () => new Response('secret provider error', { status: 403 }) }));
  const failed = db.prepare('SELECT status,last_error,attempts FROM notification_outbox WHERE approval_id=?').get(permanent.approvalId!)!;
  expect(failed).toMatchObject({ status: 'failed', last_error: 'Provider status 403', attempts: 1 });
  const rateLimited = engine.submitRequest({ ...input, idempotencyKey: 'telegram-rate-limit' });
  await deliverNotifications(telegramNotifier({ botToken: 'secret', chatId: 'chat', baseUrl: 'https://gate.example', fetchImpl: async () => new Response('{"ok":false,"error_code":429,"description":"secret"}', { status: 200 }) }));
  expect(db.prepare('SELECT status,last_error FROM notification_outbox WHERE approval_id=?').get(rateLimited.approvalId!)).toMatchObject({ status: 'retry', last_error: 'Provider status 429' });
});
it('redacts malformed Telegram error codes instead of persisting upstream text as a status', async () => {
  const { deliverNotifications, telegramNotifier } = await import('../src/notify.js');
  db.prepare("UPDATE notification_outbox SET status='obsolete'").run();
  const pending = engine.submitRequest({ ...input, idempotencyKey: 'malformed-provider' });
  await deliverNotifications(telegramNotifier({ botToken: 'secret', chatId: 'chat', baseUrl: 'https://gate.example', fetchImpl: async () => new Response('{"ok":false,"error_code":"secret-provider-text"}', { status: 200 }) }));
  expect(db.prepare('SELECT status,last_error FROM notification_outbox WHERE approval_id=?').get(pending.approvalId!)).toMatchObject({ status: 'retry', last_error: 'Provider status 502' });
});
