// Engine: the single front door for spend intents.
// evaluate → allow (ledger) | deny (ledger) | escalate (approval queue → wait for a human → ledger).
import { randomUUID } from 'node:crypto';
import type { ApprovalRequest, LedgerDecision, Rail, SpendIntent } from './types.js';
import { store } from './store.js';
import { evaluate } from './policy.js';
import { appendLedger } from './ledger.js';
import { awaitDecisionAsync, resolveWaiter } from './waiters.js';
import { cleanStr } from './sanitize.js';

export const APPROVAL_TIMEOUT_MS = Number(process.env.SPENDGATE_APPROVAL_TIMEOUT_MS ?? 5 * 60 * 1000);

// --- tiny event bus (WS broadcast hooks in from index.ts) ---
type Event =
  | { type: 'ledger'; entry: unknown }
  | { type: 'approvals'; pending: unknown[] }
  | { type: 'state' };
const listeners = new Set<(e: Event) => void>();
export function onEvent(fn: (e: Event) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(e: Event): void {
  for (const fn of listeners) fn(e);
}

export class EngineError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface SpendResult {
  intent: SpendIntent;
  decision: LedgerDecision;
  rule: string;
  reason: string;
  decidedBy: string;
  approvalId: string | null;
  ledgerSeq: number;
}

export async function submitSpend(input: {
  agentId: string;
  amount: number;
  currency: string;
  vendor: string;
  purpose: string;
  rail: Rail;
  idempotencyKey?: string;
}): Promise<SpendResult> {
  const agent = store.listAgents().find((a) => a.agentId === input.agentId);
  if (!agent) throw new EngineError(`Unknown agent "${input.agentId}". Register it in the console first.`, 404);

  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new EngineError('amount must be a positive integer in minor units (pence/cents).', 422);
  }
  if (input.amount > 1e12) {
    throw new EngineError('amount exceeds the maximum of 10,000,000,000.00.', 422);
  }
  const vendor = cleanStr(input.vendor, 'vendor', 120);
  const purpose = cleanStr(input.purpose, 'purpose', 280);
  if (!vendor || !purpose) {
    throw new EngineError('vendor and purpose are required.', 422);
  }
  const currency = typeof input.currency === 'string' ? input.currency.toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new EngineError('currency must be a 3-letter ISO 4217 code.', 422);
  }

  const policy = store.getPolicy(input.agentId);
  if (!policy) throw new EngineError(`No policy for agent "${input.agentId}".`, 409);

  // Idempotency: claim the key before any processing. A retry with the same
  // key replays the original outcome instead of spending again — agents that
  // retry after timeouts/parsing errors can never double-spend.
  let idemKey: string | null = null;
  if (input.idempotencyKey != null) {
    const key = cleanStr(input.idempotencyKey, 'idempotencyKey', 128);
    if (!key) throw new EngineError('idempotencyKey must be a non-empty string.', 422);
    const claim = store.claimIdempotencyKey(input.agentId, key);
    if (!claim.fresh) {
      const ex = claim.existing;
      if (ex?.ledgerSeq != null) {
        const entry = store.ledgerEntryBySeq(ex.ledgerSeq);
        if (entry) {
          return {
            intent: {
              id: entry.intentId,
              agentId: entry.agentId,
              amount: entry.amount,
              currency: entry.currency,
              vendor: entry.vendor,
              purpose: entry.purpose,
              rail: entry.rail,
            },
            decision: entry.decision,
            rule: entry.rule,
            reason: ex.reason ?? entry.rule,
            decidedBy: entry.decidedBy,
            approvalId: entry.approvalId,
            ledgerSeq: entry.seq,
          };
        }
      }
      throw new EngineError(
        `Duplicate idempotency key "${key}" — its escalation is still awaiting a human decision.`,
        409,
      );
    }
    idemKey = key;
  }

  const intent: SpendIntent = {
    id: randomUUID(),
    agentId: input.agentId,
    amount: input.amount,
    currency,
    vendor,
    purpose,
    rail: input.rail,
  };

  const verdict = evaluate(policy, intent, {
    spentTodayMinor: store.spentToday(input.agentId),
    knownVendors: store.knownVendors(input.agentId),
    now: new Date(),
  });

  if (verdict.decision === 'ALLOW' || verdict.decision === 'DENY') {
    const decision: LedgerDecision = verdict.decision === 'ALLOW' ? 'ALLOWED' : 'DENIED';
    const entry = appendLedger({ intent, decision, rule: verdict.rule, decidedBy: 'policy' });
    if (idemKey) store.settleIdempotencyKey(input.agentId, idemKey, { ledgerSeq: entry.seq, approvalId: null, reason: verdict.reason });
    emit({ type: 'ledger', entry });
    emit({ type: 'state' });
    return { intent, decision, rule: verdict.rule, reason: verdict.reason, decidedBy: 'policy', approvalId: null, ledgerSeq: entry.seq };
  }

  // ESCALATE — park the intent in the approval queue and wait for a human.
  const approval: ApprovalRequest = {
    id: randomUUID(),
    intent,
    rule: verdict.rule,
    reason: verdict.reason,
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    note: null,
  };
  store.createApproval(approval);
  emit({ type: 'approvals', pending: store.pendingApprovals() });
  emit({ type: 'state' });

  const outcome = await awaitDecisionAsync(approval.id, APPROVAL_TIMEOUT_MS);

  if (outcome === 'expired') {
    // Mark the queue row so the dashboard agrees with the ledger.
    store.decideApproval(approval.id, 'rejected', 'expiry', 'Escalation timed out');
  }
  const decided =
    outcome === 'approved' ? `human:${store.getApproval(approval.id)?.decidedBy ?? 'unknown'}`
    : outcome === 'rejected' ? `human:${store.getApproval(approval.id)?.decidedBy ?? 'unknown'}`
    : 'expiry';

  const decisionMap = { approved: 'APPROVED', rejected: 'REJECTED', expired: 'EXPIRED' } as const;
  const entry = appendLedger({
    intent,
    decision: decisionMap[outcome],
    rule: verdict.rule,
    decidedBy: decided,
    approvalId: approval.id,
  });
  if (idemKey) {
    store.settleIdempotencyKey(input.agentId, idemKey, {
      ledgerSeq: entry.seq,
      approvalId: approval.id,
      reason: outcome === 'expired' ? 'No human decided in time — escalations expire denied.' : verdict.reason,
    });
  }
  emit({ type: 'ledger', entry });
  emit({ type: 'approvals', pending: store.pendingApprovals() });
  emit({ type: 'state' });

  return {
    intent,
    decision: decisionMap[outcome],
    rule: verdict.rule,
    reason: outcome === 'expired' ? 'No human decided in time — escalations expire denied.' : verdict.reason,
    decidedBy: decided,
    approvalId: approval.id,
    ledgerSeq: entry.seq,
  };
}

/** Human decision from the console. Returns false if already decided. */
export function decide(approvalId: string, approve: boolean, by: string, note?: string): boolean {
  const status = approve ? 'approved' : 'rejected';
  const ok = store.decideApproval(approvalId, status, by, note ?? null);
  if (!ok) return false;
  resolveWaiter(approvalId, status);
  emit({ type: 'approvals', pending: store.pendingApprovals() });
  emit({ type: 'state' });
  return true;
}

/** Expire stale escalations — called on an interval from index.ts. */
export function expireStale(): void {
  const cutoff = new Date(Date.now() - APPROVAL_TIMEOUT_MS).toISOString();
  for (const a of store.stalePending(cutoff)) {
    store.decideApproval(a.id, 'rejected', 'expiry', 'Escalation timed out');
    // With a live waiter the blocked submitSpend continues and appends the
    // EXPIRED row itself. After a process restart no waiter exists — append
    // here so every intent still lands in the ledger regardless of outcome.
    if (!resolveWaiter(a.id, 'expired')) {
      appendLedger({
        intent: a.intent,
        decision: 'EXPIRED',
        rule: a.rule,
        decidedBy: 'expiry',
        approvalId: a.id,
      });
      emit({ type: 'ledger', entry: store.recentLedger(1)[0] });
    }
  }
  emit({ type: 'approvals', pending: store.pendingApprovals() });
  emit({ type: 'state' });
}
