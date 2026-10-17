// Unit tests for the engine front door: allow, deny, escalate-and-decide,
// input guards and idempotency. Isolated temp data dir per run.
import { beforeAll, describe, expect, it, vi } from 'vitest';

// MUST run before the static imports below pull in store.ts — vitest hoists
// this above every import, so the real .tollkeep dir is never touched.
// (store.ts mkdirs the path itself; no fs import needed inside the hoisted block)
const env = vi.hoisted(() => {
  process.env.TOLLKEEP_DATA = `/tmp/tollkeep-test-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return process.env.TOLLKEEP_DATA;
});

import { decide, EngineError, submitSpend } from '../src/core/engine.js';
import { verifyLedger } from '../src/core/ledger.js';
import { InputError } from '../src/core/sanitize.js';
import { store } from '../src/core/store.js';
import type { Policy } from '../src/core/types.js';

const AGENT = 'engine-test';
const POLICY: Policy = {
  agentId: AGENT,
  maxPerTxn: 10_000,
  dailyBudget: 500_000, budgetMode: 'hard-stop',
  approvalThreshold: 20_000,
  allowedVendors: '*',
  blockedVendors: ['evil-corp'],
  newVendorRequiresApproval: false,
  allowedDays: '*',
  allowedWindow: null,
};

function spend(over: Record<string, unknown> = {}) {
  return submitSpend({
    agentId: AGENT,
    amount: 5_000,
    currency: 'gbp', // lowercase on purpose — must be normalised
    vendor: 'acme',
    purpose: 'engine test',
    rail: 'mcp',
    ...over,
  });
}

beforeAll(() => {
  store.upsertAgent(AGENT, 'Engine Test', 'GBP');
  store.upsertPolicy(POLICY);
});

describe('submitSpend — input guards', () => {
  it('rejects unknown agents (404)', async () => {
    await expect(spend({ agentId: 'nobody' })).rejects.toMatchObject({ status: 404 });
  });

  it('rejects non-positive, fractional and absurd amounts (422)', async () => {
    await expect(spend({ amount: 0 })).rejects.toMatchObject({ status: 422 });
    await expect(spend({ amount: -5 })).rejects.toMatchObject({ status: 422 });
    await expect(spend({ amount: 10.5 })).rejects.toMatchObject({ status: 422 });
    await expect(spend({ amount: 1e12 + 1 })).rejects.toMatchObject({ status: 422 });
  });

  it('rejects bad currencies and empty vendor/purpose (422)', async () => {
    await expect(spend({ currency: 'gb' })).rejects.toMatchObject({ status: 422 });
    await expect(spend({ currency: 'GBPP' })).rejects.toMatchObject({ status: 422 });
    // empty vendor/purpose surface as InputError — the REST layer maps those to 422
    await expect(spend({ vendor: '  ' })).rejects.toThrow(InputError);
    await expect(spend({ purpose: '' })).rejects.toThrow(InputError);
  });
});

describe('submitSpend — policy paths', () => {
  it('auto-allows in-policy intents and writes a signed ledger row', async () => {
    const r = await spend({ amount: 5_000, idempotencyKey: 'allow-1' });
    expect(r.decision).toBe('ALLOWED');
    expect(r.rule).toBe('within-policy');
    expect(r.decidedBy).toBe('policy');
    expect(verifyLedger().valid).toBe(true);
  });

  it('hard-denies blocked vendors without queueing an approval', async () => {
    const r = await spend({ vendor: 'EVIL-CORP', amount: 100, idempotencyKey: 'deny-1' });
    expect(r.decision).toBe('DENIED');
    expect(r.rule).toBe('vendor-blocked');
    expect(store.pendingApprovals()).toHaveLength(0);
  });

  it('escalates over-threshold intents and resolves APPROVED on human decision', async () => {
    const p = spend({ amount: 25_000, idempotencyKey: 'esc-1' });
    await new Promise((r) => setTimeout(r, 50)); // let the queue row land
    const approval = store.pendingApprovals().at(-1)!;
    expect(approval.status).toBe('pending');
    expect(decide(approval.id, true, 'tester', 'looks fine')).toBe(true);
    const r = await p;
    expect(r.decision).toBe('APPROVED');
    expect(r.decidedBy).toBe('human:tester');
    expect(verifyLedger().valid).toBe(true);
  });

  it('resolves REJECTED when the human says no', async () => {
    const p = spend({ amount: 25_000, idempotencyKey: 'esc-2' });
    await new Promise((r) => setTimeout(r, 50));
    const approval = store.pendingApprovals().at(-1)!;
    decide(approval.id, false, 'tester', 'no');
    expect((await p).decision).toBe('REJECTED');
  });

  it('double-deciding the same approval returns false and does not corrupt state', async () => {
    const p = spend({ amount: 25_000, idempotencyKey: 'esc-3' });
    await new Promise((r) => setTimeout(r, 50));
    const approval = store.pendingApprovals().at(-1)!;
    expect(decide(approval.id, true, 'one')).toBe(true);
    expect(decide(approval.id, false, 'two')).toBe(false);
    expect((await p).decision).toBe('APPROVED');
  });
});

describe('submitSpend — idempotency', () => {
  it('replays the original outcome on retry with the same key', async () => {
    const first = await spend({ amount: 7_000, idempotencyKey: 'idem-allow' });
    const retry = await spend({ amount: 7_000, idempotencyKey: 'idem-allow' });
    expect(retry.ledgerSeq).toBe(first.ledgerSeq);
    expect(store.fullLedger().filter((e) => e.intentId === first.intent.id)).toHaveLength(1);
  });

  it('resumes both blocking callers for a duplicate pending key', async () => {
    const p = spend({ amount: 25_000, idempotencyKey: 'idem-pending' });
    await new Promise((r) => setTimeout(r, 50));
    const retry = spend({ amount: 25_000, idempotencyKey: 'idem-pending' });
    const approval = store.pendingApprovals().at(-1)!;
    decide(approval.id, true, 'tester');
    expect(await retry).toEqual(await p);
  });

  it('rejects empty idempotency keys', async () => {
    await expect(spend({ idempotencyKey: '   ' })).rejects.toThrow(InputError);
  });
});

describe('EngineError shape', () => {
  it('carries an HTTP status for the REST layer', () => {
    const e = new EngineError('boom', 409);
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(409);
  });
});

describe('budget authorisation integration', () => {
  it('rejects a supported currency that differs from the configured agent currency', async () => {
    await expect(spend({ currency: 'USD' })).rejects.toMatchObject({ status: 422 });
  });
  it('hard-stops before a per-transaction escalation and records no permission as completed spend', async () => {
    store.upsertAgent('hard-budget', 'Hard budget', 'GBP');
    store.upsertPolicy({ ...POLICY, agentId: 'hard-budget', dailyBudget: 100, budgetMode: 'hard-stop', maxPerTxn: 50 });
    const r = await spend({ agentId: 'hard-budget', amount: 101 });
    expect(r.decision).toBe('DENIED');
    expect(r.rule).toBe('over-daily-budget');
    expect(store.pendingApprovals().filter(a => a.intent.agentId === 'hard-budget')).toHaveLength(0);
    const allowed = await spend({ agentId: 'hard-budget', amount: 40, idempotencyKey: 'budget-once' });
    await spend({ agentId: 'hard-budget', amount: 40, idempotencyKey: 'budget-once' });
    const { budget } = await import('../src/core/budget-state.js');
    expect(budget.getBudgetSnapshot('hard-budget')).toMatchObject({ spentMinor: 0, reservedMinor: 40, remainingMinor: 60 });
    expect(budget.getReservation(allowed.requestId)?.amountMinor).toBe(40);
  });
  it('pending approval reserves nothing; competing authorisations can exhaust funds before approval', async () => {
    store.upsertAgent('approve-budget', 'Approve budget', 'GBP');
    store.upsertPolicy({ ...POLICY, agentId: 'approve-budget', dailyBudget: 100, budgetMode: 'hard-stop', maxPerTxn: 50 });
    const pending = spend({ agentId: 'approve-budget', amount: 60 });
    const a = store.pendingApprovals().find(a => a.intent.agentId === 'approve-budget')!;
    const { budget } = await import('../src/core/budget-state.js');
    expect(budget.getBudgetSnapshot('approve-budget').reservedMinor).toBe(0);
    await spend({ agentId: 'approve-budget', amount: 50 });
    expect(() => decide(a.id, true, 'operator')).toThrow(/funds/i);
    expect(store.getApproval(a.id)?.status).toBe('pending');
    decide(a.id, false, 'operator'); await pending;
    expect(budget.getBudgetSnapshot('approve-budget').reservedMinor).toBe(50);
  });
  it('records an explicit override in accounting and the signed decision rule', async () => {
    store.upsertAgent('override-budget', 'Override budget', 'GBP');
    store.upsertPolicy({ ...POLICY, agentId: 'override-budget', dailyBudget: 100, budgetMode: 'approval-override' });
    const pending = spend({ agentId: 'override-budget', amount: 120 });
    const a = store.pendingApprovals().find(a => a.intent.agentId === 'override-budget')!;
    expect(() => decide(a.id, true, 'decision-link')).toThrow(/console/i);
    expect(() => decide(a.id, true, 'operator')).toThrow(/reason/i);
    decide(a.id, true, 'operator', 'Necessary exception');
    const r = await pending;
    expect(r.rule).toBe('budget-override:over-daily-budget');
    const { budget } = await import('../src/core/budget-state.js');
    expect(budget.getBudgetSnapshot('override-budget')).toMatchObject({ spentMinor: 0, reservedMinor: 120, remainingMinor: -20 });
  });
});
