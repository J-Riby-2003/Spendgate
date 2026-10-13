// Policy engine: every intent gets ALLOW, DENY or ESCALATE — default-deny posture.
import type { Policy, PolicyDecision, Rail, SpendIntent } from './types.js';

export interface EvalResult {
  decision: PolicyDecision;
  rule: string;
  reason: string;
}

export interface EvalContext {
  spentTodayMinor: number;
  reservedMinor?: number;
  knownVendors: Set<string>;
  now: Date;
}

function inWindow(window: { start: string; end: string }, now: Date): boolean {
  const [sh, sm] = window.start.split(':').map(Number);
  const [eh, em] = window.end.split(':').map(Number);
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  return cur >= sh * 60 + sm && cur <= eh * 60 + em;
}

export function evaluate(policy: Policy, intent: SpendIntent, ctx: EvalContext): EvalResult {
  const { amount, vendor } = intent;

  if (policy.blockedVendors.map((v) => v.toLowerCase()).includes(vendor.toLowerCase())) {
    return { decision: 'DENY', rule: 'vendor-blocked', reason: `"${vendor}" is on this agent's blocklist.` };
  }

  if (policy.dailyBudget != null && ctx.spentTodayMinor + (ctx.reservedMinor ?? 0) + amount > policy.dailyBudget) {
    return { decision: policy.budgetMode === 'approval-override' ? 'ESCALATE' : 'DENY', rule: 'over-daily-budget',
      reason: policy.budgetMode === 'approval-override' ? 'Insufficient available budget — an explicit human override is required.' : 'Insufficient available budget — this policy has a hard stop.' };
  }

  if (policy.allowedVendors !== '*') {
    const ok = policy.allowedVendors.some((v) => v.toLowerCase() === vendor.toLowerCase());
    if (!ok) {
      return { decision: 'ESCALATE', rule: 'vendor-not-allowlisted', reason: `"${vendor}" is not on the approved vendor list.` };
    }
  }

  if (policy.maxPerTxn != null && amount > policy.maxPerTxn) {
    return { decision: 'ESCALATE', rule: 'over-max-per-txn', reason: `Amount exceeds the per-transaction auto-approve ceiling — a human must sign off.` };
  }

  if (policy.approvalThreshold != null && amount >= policy.approvalThreshold) {
    return { decision: 'ESCALATE', rule: 'over-approval-threshold', reason: `Amount is at or above the human-approval threshold.` };
  }

  if (policy.newVendorRequiresApproval && !ctx.knownVendors.has(vendor.toLowerCase())) {
    const seenBefore = [...ctx.knownVendors].some((v) => v === vendor.toLowerCase());
    if (!seenBefore) {
      return { decision: 'ESCALATE', rule: 'new-vendor', reason: `First payment to "${vendor}" — new vendors need a human yes.` };
    }
  }

  if (policy.allowedDays !== '*') {
    if (!policy.allowedDays.includes(ctx.now.getUTCDay())) {
      return { decision: 'ESCALATE', rule: 'outside-allowed-days', reason: `Spending is restricted to ${policy.allowedDays.map(dName).join(', ')}.` };
    }
  }

  if (policy.allowedWindow && !inWindow(policy.allowedWindow, ctx.now)) {
    return { decision: 'ESCALATE', rule: 'outside-allowed-hours', reason: `Outside the allowed window (${policy.allowedWindow.start}–${policy.allowedWindow.end}).` };
  }

  return { decision: 'ALLOW', rule: 'within-policy', reason: 'Within all policy limits.' };
}

function dName(d: number): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d];
}

export function isRail(v: string): v is Rail {
  return ['x402', 'mpp', 'ap2', 'acp', 'card', 'stablecoin', 'mcp'].includes(v);
}
