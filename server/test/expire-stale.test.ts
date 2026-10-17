// Expiry with no live waiter (process restarted mid-escalation) must still
// land an EXPIRED row in the signed ledger — every intent is accounted for.
import { beforeAll, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  process.env.SPENDLOCK_DATA = `/tmp/spendlock-test-expire-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return process.env.SPENDLOCK_DATA;
});

import { expireStale } from '../src/core/engine.js';
import { verifyLedger } from '../src/core/ledger.js';
import { store } from '../src/core/store.js';
import type { ApprovalRequest, Policy } from '../src/core/types.js';

const AGENT = 'expire-test';
const POLICY: Policy = {
  agentId: AGENT,
  maxPerTxn: 10_000,
  dailyBudget: 500_000, budgetMode: 'hard-stop',
  approvalThreshold: 20_000,
  allowedVendors: '*',
  blockedVendors: [],
  newVendorRequiresApproval: false,
  allowedDays: '*',
  allowedWindow: null,
};

beforeAll(() => {
  store.upsertAgent(AGENT, 'Expire Test', 'GBP');
  store.upsertPolicy(POLICY);
});

describe('expireStale — no live waiter (post-restart)', () => {
  it('marks the approval expired and appends an EXPIRED ledger row', async () => {
    const approval: ApprovalRequest = {
      id: 'expire-restart-1',
      intent: {
        id: 'intent-expire-1',
        agentId: AGENT,
        amount: 99_000,
        currency: 'GBP',
        vendor: 'acme',
        purpose: 'restart expiry test',
        rail: 'mcp',
      },
      rule: 'over-approval-threshold',
      reason: 'test',
      status: 'pending',
      createdAt: new Date(Date.now() - 300001).toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: null,
    };
    store.createApproval(approval);

    expireStale();

    const settled = store.getApproval(approval.id);
    expect(settled?.status).toBe('expired');
    expect(settled?.decidedBy).toBe('expiry');

    const entry = store.recentLedger(1)[0];
    expect(entry.decision).toBe('EXPIRED');
    expect(entry.decidedBy).toBe('expiry');
    expect(entry.intentId).toBe('intent-expire-1');
    expect(verifyLedger().valid).toBe(true);
  });
});
