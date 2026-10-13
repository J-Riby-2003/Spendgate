import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { migrate, migrations } from '../src/core/migrations.js';
import { withImmediateTransaction } from '../src/core/transactions.js';
import { createBudgetStore } from '../src/core/budget.js';
let db: DatabaseSync;
let budget: ReturnType<typeof createBudgetStore>;
const day1 = new Date('2026-10-13T23:59:00Z');
const day2 = new Date('2026-10-14T00:01:00Z');
const input = (requestId = 'r1', amountMinor = 3000) => ({ requestId, agentId: 'a', amountMinor, currency: 'GBP', expiresAt: '2026-10-14T01:00:00Z' });
function tx<T>(fn: () => T) { return withImmediateTransaction(db, fn); }
beforeEach(() => {
  db = new DatabaseSync(':memory:'); migrate(db);
  db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run('a', 'A', 'GBP');
  db.prepare('INSERT INTO policies VALUES (?, ?)').run('a', JSON.stringify({ agentId: 'a', dailyBudget: 10000, budgetMode: 'hard-stop' }));
  budget = createBudgetStore(db);
});
afterEach(() => db.close());
it('reserves permission without treating it as completed spend and preserves available funds on same-day settlement', () => {
  tx(() => budget.reserveBudget(input(), day1));
  expect(budget.getBudgetSnapshot('a', day1)).toMatchObject({ spentMinor: 0, reservedMinor: 3000, remainingMinor: 7000 });
  tx(() => budget.settleReservation('r1', 'receipt-1', day1));
  expect(budget.getBudgetSnapshot('a', day1)).toMatchObject({ spentMinor: 3000, reservedMinor: 0, remainingMinor: 7000 });
});
it('carries unresolved holds across UTC midnight and attributes settlement only to the original period', () => {
  tx(() => budget.reserveBudget(input(), day1));
  expect(budget.getBudgetSnapshot('a', day2)).toMatchObject({ spentMinor: 0, reservedMinor: 3000, remainingMinor: 7000, periodStart: '2026-10-14T00:00:00.000Z' });
  tx(() => budget.reserveBudget(input('r2', 2000), day2));
  tx(() => budget.settleReservation('r2', 'receipt-2', day2));
  tx(() => budget.settleReservation('r1', 'receipt-1', day2));
  expect(budget.getBudgetSnapshot('a', day2)).toMatchObject({ spentMinor: 2000, reservedMinor: 0, remainingMinor: 8000 });
  expect(budget.getBudgetSnapshot('a', day1).spentMinor).toBe(3000);
});
it('rejects oversubscription and currency mismatch with no side effects', () => {
  tx(() => budget.reserveBudget(input('r1', 7000), day1));
  expect(() => tx(() => budget.reserveBudget(input('r2', 4000), day1))).toThrow(/funds/i);
  expect(() => tx(() => budget.reserveBudget({ ...input('r3'), currency: 'USD' }, day1))).toThrow(/currency/i);
  expect(budget.getBudgetSnapshot('a', day1).reservedMinor).toBe(7000);
});
it('permits audited overrides only in approval-override mode and exposes negative remaining', () => {
  const override = { operatorId: 'operator-1', reason: 'Business exception' };
  expect(() => tx(() => budget.reserveBudget({ ...input('r1', 12000), override }, day1))).toThrow(/funds/i);
  db.prepare('UPDATE policies SET json = ?').run(JSON.stringify({ dailyBudget: 10000, budgetMode: 'approval-override' }));
  expect(() => tx(() => budget.reserveBudget(input('r1', 12000), day1))).toThrow(/funds/i);
  tx(() => budget.reserveBudget({ ...input('r1', 12000), override }, day1));
  expect(budget.getBudgetSnapshot('a', day1).remainingMinor).toBe(-2000);
  expect(budget.accountingEvents('a')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'reserved', operatorId: 'operator-1', reason: 'Business exception', override: true })]));
});
it('replays duplicates, rejects conflicting reuse and terminal transitions, and never releases twice', () => {
  tx(() => budget.reserveBudget(input(), day1)); tx(() => budget.reserveBudget(input(), day1));
  expect(() => tx(() => budget.reserveBudget(input('r1', 4000), day1))).toThrow(/conflict/i);
  tx(() => budget.releaseReservation('r1', 'fail-1', 'failed', day1));
  tx(() => budget.releaseReservation('r1', 'fail-1', 'failed', day1));
  expect(budget.getBudgetSnapshot('a', day1)).toMatchObject({ spentMinor: 0, reservedMinor: 0, remainingMinor: 10000 });
  expect(() => tx(() => budget.settleReservation('r1', 'late-receipt', day1))).toThrow(/reconcil/i);
  expect(budget.accountingEvents('a')).toHaveLength(2);
});
it('requires an outer transaction so the finaliser can roll back reservation and decision together', () => {
  expect(() => budget.reserveBudget(input(), day1)).toThrow(/transaction/i);
  expect(() => tx(() => { budget.reserveBudget(input(), day1); throw new Error('decision write failed'); })).toThrow();
  expect(budget.getBudgetSnapshot('a', day1).reservedMinor).toBe(0);
});
it('does not release ambiguous in-flight holds just because their expiry timestamp passes', () => {
  tx(() => budget.reserveBudget(input(), day1));
  expect(budget.getBudgetSnapshot('a', new Date('2026-10-15T00:00:00Z')).reservedMinor).toBe(3000);
});
it('migrates existing policies explicitly and gates only unknown legacy obligations without rewriting history', () => {
  const legacy = new DatabaseSync(':memory:'); migrate(legacy, migrations.slice(0, 2));
  legacy.exec(`INSERT INTO agents VALUES ('old','Old','GBP'); INSERT INTO policies VALUES ('old','{"agentId":"old","dailyBudget":10000}');
    INSERT INTO ledger VALUES (1,'2026-10-13T10:00:00Z','legacy-i','old',5000,'GBP','vendor','purpose','mcp','ALLOWED','rule','policy',NULL,'GENESIS','hash','signature')`);
  const history = JSON.stringify(legacy.prepare('SELECT * FROM ledger').all());
  migrate(legacy); migrate(legacy);
  const b = createBudgetStore(legacy);
  expect(b.getBudgetSnapshot('old', day1)).toMatchObject({ mode: 'approval-override', spentMinor: 0, reconciliationRequired: true });
  expect(() => withImmediateTransaction(legacy, () => b.reserveBudget({ ...input(), agentId: 'old' }, day1))).toThrow(/reconcil/i);
  withImmediateTransaction(legacy, () => b.reconcileLegacy({ ledgerSeq: 1, action: 'no-outstanding-obligation', operatorId: 'op', reason: 'Reviewed records', eventId: 'review-1' }, day1));
  expect(b.getBudgetSnapshot('old', day1)).toMatchObject({ spentMinor: 0, reconciliationRequired: false });
  expect(b.legacyObligations('old')[0]).toMatchObject({ disposition: 'no-outstanding-obligation', executionStatus: 'unknown' });
  expect(JSON.stringify(legacy.prepare('SELECT * FROM ledger').all())).toBe(history);
  legacy.close();
});
it('requires evidence for confirmed legacy payment and makes reconciliation idempotent', () => {
  db.exec(`INSERT INTO ledger VALUES (1,'2026-10-13T10:00:00Z','legacy-i','a',5000,'GBP','vendor','purpose','mcp','APPROVED','rule','human:op',NULL,'GENESIS','hash','signature');
    INSERT INTO legacy_budget_obligations (ledger_seq, agent_id) VALUES (1, 'a')`);
  const review = { ledgerSeq: 1, action: 'confirmed-paid' as const, operatorId: 'op', reason: 'Provider confirmation', eventId: 'review-1' };
  expect(() => tx(() => budget.reconcileLegacy(review, day1))).toThrow(/evidence/i);
  tx(() => budget.reconcileLegacy({ ...review, evidence: 'provider receipt 123' }, day1));
  tx(() => budget.reconcileLegacy({ ...review, evidence: 'provider receipt 123' }, day1));
  expect(budget.getBudgetSnapshot('a', day1)).toMatchObject({ spentMinor: 5000, reservedMinor: 0, reconciliationRequired: false });
  expect(() => tx(() => budget.reconcileLegacy({ ...review, evidence: 'different receipt' }, day1))).toThrow(/conflict/i);
});
it('replays an existing reservation after its expiry and never acquires a second hold', () => {
  tx(() => budget.reserveBudget(input(), day1));
  expect(tx(() => budget.reserveBudget(input(), new Date('2026-10-15T00:00:00Z'))).status).toBe('reserved');
  expect(budget.getBudgetSnapshot('a', day2).reservedMinor).toBe(3000);
});
it('lets an operator resolve a previously identified outstanding legacy obligation with evidence', () => {
  db.exec(`INSERT INTO ledger VALUES (1,'2026-10-13T10:00:00Z','legacy-i','a',5000,'GBP','vendor','purpose','mcp','APPROVED','rule','human:op',NULL,'GENESIS','hash','signature');
    INSERT INTO legacy_budget_obligations (ledger_seq, agent_id) VALUES (1, 'a')`);
  tx(() => budget.reconcileLegacy({ ledgerSeq: 1, action: 'outstanding', operatorId: 'op', reason: 'Payment still uncertain', eventId: 'review-1' }, day1));
  expect(budget.getBudgetSnapshot('a', day2)).toMatchObject({ reservedMinor: 5000, reconciliationRequired: false });
  tx(() => budget.reconcileLegacy({ ledgerSeq: 1, action: 'confirmed-paid', evidence: 'receipt 42', operatorId: 'op', reason: 'Provider confirmed', eventId: 'review-2' }, day2));
  expect(budget.getBudgetSnapshot('a', day2)).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
  expect(budget.getBudgetSnapshot('a', day1).spentMinor).toBe(5000);
  expect(budget.accountingEvents('a').filter(e => e.kind === 'legacy-reconciled')).toHaveLength(2);
});
it('refuses reservation without a policy rather than interpreting it as unlimited', () => {
  db.exec('DELETE FROM policies');
  expect(() => tx(() => budget.reserveBudget(input(), day1))).toThrow(/policy/i);
});
