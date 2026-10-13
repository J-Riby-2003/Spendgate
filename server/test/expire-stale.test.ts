// Expiry with no live waiter (process restarted mid-escalation) must still
// land an EXPIRED row in the signed ledger — every intent is accounted for.
import { beforeAll, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  process.env.SPENDGATE_DATA = `/tmp/spendgate-test-expire-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.SPENDGATE_APPROVAL_TIMEOUT_MS = '80';
  return process.env.SPENDGATE_DATA;
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
  it('marks the approval rejected and appends an EXPIRED ledger row', async () => {
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
      createdAt: new Date().toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: null,
    };
    store.createApproval(approval);

    await new Promise((r) => setTimeout(r, 120)); // outlast the 80ms timeout
    expireStale();

    const settled = store.getApproval(approval.id);
    expect(settled?.status).toBe('rejected');
    expect(settled?.decidedBy).toBe('expiry');

    const entry = store.recentLedger(1)[0];
    expect(entry.decision).toBe('EXPIRED');
    expect(entry.decidedBy).toBe('expiry');
    expect(entry.intentId).toBe('intent-expire-1');
    expect(verifyLedger().valid).toBe(true);
  });
});
