// Derived read projection only. Finalisation always rechecks identity, deadline and funds.
import { db, store } from './store.js';
import { budget } from './budget-state.js';
import type { ApprovalRequest } from './types.js';
import type { ApprovalDecisionContext, ApprovalBudgetPreview, VendorHistory } from '../../../shared/approval-context.js';

// SQLite lower() handles ASCII only; use the same Unicode case mapping as the policy inputs.
db.function('spendlock_vendor_key', { deterministic: true }, (value: unknown) => String(value).toLowerCase());

export type ContextualApproval = ApprovalRequest & { requestId: string; context: ApprovalDecisionContext };

// A deferred read transaction gives each response one SQLite snapshot, without taking a writer lock.
function readSnapshot<T>(read: () => T): T {
  db.exec('BEGIN');
  try { const result = read(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function vendorHistory(a: ApprovalRequest): VendorHistory {
  try {
    const rows = db.prepare(`SELECT intent_id, ts, amount, currency, decision FROM ledger
      WHERE agent_id=? AND spendlock_vendor_key(vendor)=spendlock_vendor_key(?) AND intent_id!=? ORDER BY seq DESC LIMIT 6`)
      .all(a.intent.agentId, a.intent.vendor, a.intent.id);
    // Preserve the evaluator's existing known-vendor definition: a prior permission, not payment.
    const known = [...store.knownVendors(a.intent.agentId)].some(v => v.toLowerCase() === a.intent.vendor.toLowerCase());
    return { status: 'available', isNewVendor: !known, truncated: rows.length > 5, recent: rows.slice(0,5).map(r => ({
      requestId: String(r.intent_id), at: String(r.ts), amount: Number(r.amount), currency: String(r.currency), decision: String(r.decision),
    })) };
  } catch { return { status: 'unavailable', isNewVendor: null, reason: 'Vendor history is unavailable.' }; }
}
function project(a: ApprovalRequest, now: Date): ContextualApproval {
  const agent = store.listAgents().find(agent => agent.agentId === a.intent.agentId);
  const request = db.prepare('SELECT reconciliation_required FROM spend_requests WHERE request_id=?').get(a.intent.id);
  const recovery = !request || Boolean(request.reconciliation_required);
  const agentRecovery = db.prepare('SELECT 1 FROM spend_requests WHERE agent_id=? AND reconciliation_required=1 LIMIT 1').get(a.intent.agentId);
  let budgetPreview: ApprovalBudgetPreview = { status: 'unavailable', reason: 'Budget context is unavailable.' };
  let approveReason: string | null = null;
  try {
    const snapshot = budget.getBudgetSnapshot(a.intent.agentId, now);
    const additionalReservedMinor = a.status === 'pending' ? a.intent.amount : 0;
    const projectedRemainingMinor = snapshot.remainingMinor == null ? null : snapshot.remainingMinor - additionalReservedMinor;
    const over = projectedRemainingMinor != null && projectedRemainingMinor < 0;
    budgetPreview = { status: 'available', snapshot, additionalReservedMinor, projectedRemainingMinor,
      overrideRequired: a.status === 'pending' && over && snapshot.mode === 'approval-override' };
    if (snapshot.reconciliationRequired || agentRecovery) approveReason = 'Legacy records require reconciliation before authorisation.';
    else if (!store.getPolicy(a.intent.agentId)) approveReason = 'No policy for this agent.';
    else if (snapshot.currency !== a.intent.currency || snapshot.precision == null) approveReason = 'Request currency cannot be authorised.';
    else if (over && snapshot.mode === 'hard-stop') approveReason = 'Insufficient budget. Hard-stop mode does not permit an override.';
  } catch { approveReason = 'Budget context is unavailable. Refresh before approving.'; }
  const expires = Date.parse(a.expiresAt ?? '');
  const finalReason = recovery ? 'Legacy request requires audited reconciliation.'
    : a.status !== 'pending' ? `Request is already ${a.status}.`
    : !Number.isFinite(expires) ? 'Expiry is unavailable. Refresh before deciding.'
    : now.getTime() >= expires ? 'Request has expired.' : null;
  return { ...a, requestId: a.intent.id, context: {
    serverNow: now.toISOString(), agent: { id: a.intent.agentId, displayName: agent?.displayName ?? a.intent.agentId },
    budget: budgetPreview, vendorHistory: vendorHistory(a),
    actions: { approve: { enabled: !(finalReason || approveReason), reason: finalReason || approveReason },
      reject: { enabled: !finalReason, reason: finalReason } },
  } };
}
export function getApprovalContext(id: string, now = new Date()): ContextualApproval | null {
  return readSnapshot(() => { const a = store.getApproval(id); return a ? project(a, now) : null; });
}
export function approvalQueueContext(now = new Date()): { pending: ContextualApproval[]; recent: ContextualApproval[] } {
  return readSnapshot(() => ({ pending: store.pendingApprovals().map(a => project(a, now)), recent: store.recentDecidedApprovals(20).map(a => project(a, now)) }));
}
