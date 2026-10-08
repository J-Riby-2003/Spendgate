// Unit tests for the policy engine — every rule and its boundary conditions.
import { describe, expect, it } from 'vitest';
import { evaluate, isRail, type EvalContext } from '../src/core/policy.js';
import type { Policy, SpendIntent } from '../src/core/types.js';

const POLICY: Policy = {
  agentId: 'a',
  maxPerTxn: 10_000,
  dailyBudget: 50_000,
  approvalThreshold: 20_000,
  allowedVendors: '*',
  blockedVendors: ['evil-corp'],
  newVendorRequiresApproval: false,
  allowedDays: '*',
  allowedWindow: null,
};

function intent(over: Partial<SpendIntent> = {}): SpendIntent {
  return {
    id: 'i1',
    agentId: 'a',
    amount: 5_000,
    currency: 'GBP',
    vendor: 'acme',
    purpose: 'test',
    rail: 'mcp',
    ...over,
  };
}

const CTX: EvalContext = { spentTodayMinor: 0, knownVendors: new Set(['acme']), now: new Date('2026-10-08T12:00:00Z') };

describe('evaluate', () => {
  it('allows an intent within all limits', () => {
    expect(evaluate(POLICY, intent(), CTX)).toEqual({ decision: 'ALLOW', rule: 'within-policy', reason: 'Within all policy limits.' });
  });

  it('hard-denies blocked vendors (case-insensitive)', () => {
    const r = evaluate(POLICY, intent({ vendor: 'EVIL-CORP' }), CTX);
    expect(r.decision).toBe('DENY');
    expect(r.rule).toBe('vendor-blocked');
  });

  it('escalates vendors outside the allowlist', () => {
    const p: Policy = { ...POLICY, allowedVendors: ['acme'] };
    const r = evaluate(p, intent({ vendor: 'stranger' }), CTX);
    expect(r.decision).toBe('ESCALATE');
    expect(r.rule).toBe('vendor-not-allowlisted');
  });

  it('escalates over maxPerTxn (strictly greater)', () => {
    expect(evaluate(POLICY, intent({ amount: 10_000 }), CTX).decision).toBe('ALLOW');
    expect(evaluate(POLICY, intent({ amount: 10_001 }), CTX).rule).toBe('over-max-per-txn');
  });

  it('escalates at or above approvalThreshold (with per-txn cap lifted)', () => {
    const p: Policy = { ...POLICY, maxPerTxn: null };
    expect(evaluate(p, intent({ amount: 19_999 }), CTX).decision).toBe('ALLOW');
    expect(evaluate(p, intent({ amount: 20_000 }), CTX).rule).toBe('over-approval-threshold');
  });

  it('escalates first-time vendors when required', () => {
    const p: Policy = { ...POLICY, newVendorRequiresApproval: true };
    expect(evaluate(p, intent({ vendor: 'acme' }), CTX).decision).toBe('ALLOW');
    expect(evaluate(p, intent({ vendor: 'brand-new' }), CTX).rule).toBe('new-vendor');
  });

  it('escalates outside allowed days', () => {
    const p: Policy = { ...POLICY, allowedDays: [1, 2, 3, 4, 5] }; // Mon–Fri
    const thursday = new Date('2026-10-08T12:00:00Z'); // a Thursday
    expect(evaluate(p, intent(), { ...CTX, now: thursday }).decision).toBe('ALLOW');
    const sunday = new Date('2026-10-11T12:00:00Z');
    expect(evaluate(p, intent(), { ...CTX, now: sunday }).rule).toBe('outside-allowed-days');
  });

  it('escalates outside the allowed hours window', () => {
    const p: Policy = { ...POLICY, allowedWindow: { start: '09:00', end: '17:00' } };
    const noon = new Date('2026-10-08T12:00:00Z');
    expect(evaluate(p, intent(), { ...CTX, now: noon }).decision).toBe('ALLOW');
    const eightPm = new Date('2026-10-08T20:00:00Z');
    expect(evaluate(p, intent(), { ...CTX, now: eightPm }).rule).toBe('outside-allowed-hours');
  });

  it('escalates when the intent would exceed dailyBudget', () => {
    const p: Policy = { ...POLICY, maxPerTxn: null, approvalThreshold: null };
    expect(evaluate(p, intent({ amount: 45_000 }), { ...CTX, spentTodayMinor: 5_000 }).decision).toBe('ALLOW'); // exactly at budget
    expect(evaluate(p, intent({ amount: 45_000 }), { ...CTX, spentTodayMinor: 5_001 }).rule).toBe('over-daily-budget');
  });

  it('treats null limits as unlimited', () => {
    const p: Policy = { ...POLICY, maxPerTxn: null, dailyBudget: null, approvalThreshold: null };
    expect(evaluate(p, intent({ amount: 999_999_999 }), { ...CTX, spentTodayMinor: 0 }).decision).toBe('ALLOW');
  });
});

describe('isRail', () => {
  it('accepts known rails and rejects others', () => {
    expect(isRail('mcp')).toBe(true);
    expect(isRail('x402')).toBe(true);
    expect(isRail('wire')).toBe(false);
  });
});
